// The model lists of the gate pop-up (3.0.7): what the server's answer
// becomes, the snapshot without one, the checkout link, the results per way
// (only from the answer), the machine-size line and the kept pick.
//
// Run: npx vitest run src/lib/__tests__/cloud-gate.test.ts
import { describe, it, expect } from 'vitest'
import {
  GATE_PICK_TTL_MS, GATE_SEED, freshGatePick, gateCheckoutUrl, gateOfferLine, paramsInId, parseGateCatalog,
  tooBigForThisMachine, tooBigLine,
} from '../cloud-gate'

const answer = {
  version: 1,
  generatedAt: '2026-10-18T00:00:00Z',
  categories: {
    chat: [
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'DeepSeek V4.1 Flash', plans: ['hosted'] },
      { id: 'org/Model-70B', label: 'Model 70B', native_label: 'Model 70B Uncensored', plans: ['hosted'] },
      { id: 'bad id with spaces', label: 'x' },
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'twice' },
    ],
    code: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'DeepSeek V4.1 Flash' }],
    create: [
      { id: 'flux-dev', label: 'Flux Dev', kind: 'image' },
      { id: 'wan-2.2-720p', label: 'Wan 2.2', kind: 'video' },
      { id: 'qwen-image-2.1-edit', label: 'Qwen Image 2.1', kind: 'edit' },
      { id: 'chroma', label: 'Chroma', kind: 'image', adult: true },
      { id: 'song', label: 'Song', kind: 'music' },
    ],
  },
  offers: {
    plans: [
      { tier: 'hosted', interval: 'month', eur: 19, credits: 900000, images: 3000, clips: 112 },
      { tier: 'hosted', interval: 'year', eur: 190, credits: 900000, images: 3000, clips: 112 },
    ],
    packs: [{ id: 'pack-15', eur: 15, credits: 450000, images: 1500, clips: 56 }],
  },
}

describe('the server answer', () => {
  it('keeps valid models once, prefers the app name, drops unknown kinds', () => {
    const c = parseGateCatalog(answer)!
    expect(c.categories.chat.map((m) => m.id)).toEqual(['deepseek-ai/DeepSeek-V4.1-Flash', 'org/Model-70B'])
    expect(c.categories.chat[1].label).toBe('Model 70B Uncensored')
    expect(c.categories.create.map((m) => m.kind)).toEqual(['image', 'video', 'edit', 'image'])
    expect(c.categories.create[3].adult).toBe(true)
    expect(c.categories.create[0].adult).toBeUndefined()
  })

  it('is refused when it is not one', () => {
    expect(parseGateCatalog(null)).toBeNull()
    expect(parseGateCatalog({ ...answer, version: 2 })).toBeNull()
    expect(parseGateCatalog({ version: 1, categories: { chat: [] } })).toBeNull()
  })

  it('ships a snapshot with all three categories and no figures', () => {
    expect(GATE_SEED.categories.chat.length).toBeGreaterThan(10)
    expect(GATE_SEED.categories.code.length).toBeGreaterThan(10)
    for (const k of ['image', 'video', 'edit']) {
      expect(GATE_SEED.categories.create.some((m) => m.kind === k)).toBe(true)
    }
    expect(GATE_SEED.offers).toBeNull()
  })

  // 3.0.8: Kimi K3.1 Pro kommt in die Cloud, Kimi K3 bleibt. Die Reihenfolge
  // kommt seit 3.1.0 aus der öffentlichen Liste (scripts/studio-snapshot.mjs
  // --gate live) und wird hier nicht festgeschrieben.
  it('offline names Kimi K3.1 Pro and keeps Kimi K3 in Chat and Code', () => {
    for (const cat of ['chat', 'code'] as const) {
      const ids = GATE_SEED.categories[cat].map((m) => m.id)
      const pro = ids.indexOf('moonshotai/Kimi-K3.1-Pro')
      expect(pro).toBeGreaterThanOrEqual(0)
      expect(ids).toContain('moonshotai/Kimi-K3')
      expect(GATE_SEED.categories[cat][pro].label).toBe('Kimi K3.1 Pro')
      expect(paramsInId(ids[pro])).toBeNull()
    }
  })
})

describe('the checkout link', () => {
  it('carries the way, the source, the model and the category', () => {
    const sub = new URL(gateCheckoutUrl('https://lu-labs.ai', 'sub', 'deepseek-ai/DeepSeek-V4.1-Flash', 'chat'))
    expect(sub.origin + sub.pathname).toBe('https://lu-labs.ai/checkout/start')
    expect(Object.fromEntries(sub.searchParams)).toEqual({
      plan: 'hosted', interval: 'month', src: 'app-gate', model: 'deepseek-ai/DeepSeek-V4.1-Flash', category: 'chat', return: 'app',
    })
    const pack = new URL(gateCheckoutUrl('https://lu-labs.ai', 'credits', 'flux-dev', 'create'))
    expect(Object.fromEntries(pack.searchParams)).toEqual({
      pack: 'pack-15', src: 'app-gate', model: 'flux-dev', category: 'create', return: 'app',
    })
  })
})

describe('what a way buys', () => {
  it('names results from the answer, never credits', () => {
    const offers = parseGateCatalog(answer)!.offers
    expect(gateOfferLine('sub', offers)).toBe('€19 a month, about 3,000 images or 112 clips each month')
    expect(gateOfferLine('credits', offers)).toBe('€15 once, about 1,500 images or 56 clips')
    expect(gateOfferLine('sub', offers)).not.toMatch(/credit|900/i)
  })

  // Negative control: without an answer there is no figure to show.
  it('says nothing without an answer', () => {
    expect(gateOfferLine('sub', null)).toBeNull()
    expect(gateOfferLine('credits', { plans: [], packs: [] })).toBeNull()
  })
})

describe('too big for this machine', () => {
  it('reads the parameter count from the id', () => {
    expect(paramsInId('Qwen/Qwen3-235B-A22B-Instruct')).toBe(235)
    expect(paramsInId('google/gemma-4-31b-it')).toBe(31)
    expect(paramsInId('meta/Llama-3.1-8B-Turbo')).toBe(8)
    expect(paramsInId('deepseek-ai/DeepSeek-V4.1-Flash')).toBeNull()
    expect(paramsInId('moonshotai/Kimi-K3')).toBeNull()
  })

  it('marks a model whose 4 bit weights do not fit, and nothing it cannot judge', () => {
    expect(tooBigForThisMachine('google/gemma-4-31b-it', 12)).toBe(true)
    expect(tooBigForThisMachine('google/gemma-4-31b-it', 16)).toBe(true)
    expect(tooBigForThisMachine('google/gemma-4-31b-it', 24)).toBe(false)
    expect(tooBigForThisMachine('meta/Llama-3.1-8B-Turbo', 12)).toBe(false)
    expect(tooBigForThisMachine('google/gemma-4-31b-it', null)).toBe(false)
    expect(tooBigForThisMachine('moonshotai/Kimi-K3', 8)).toBe(false)
  })

  it('names the GPU on a PC and the Mac on a Mac', () => {
    expect(tooBigLine(false)).toBe('Runs in LU Cloud, too big for your GPU')
    expect(tooBigLine(true)).toBe('Runs in LU Cloud, too big for your Mac')
  })
})

describe('the kept pick', () => {
  const pick = { model: 'flux-dev', category: 'create' as const, kind: 'image' as const, at: 1_000 }
  it('holds for a week', () => {
    expect(freshGatePick(pick, 1_000 + GATE_PICK_TTL_MS - 1)).toEqual(pick)
    expect(freshGatePick(pick, 1_000 + GATE_PICK_TTL_MS)).toBeNull()
  })
  it('drops what is not a pick', () => {
    expect(freshGatePick(null, 0)).toBeNull()
    expect(freshGatePick({ ...pick, model: 'a b' }, 1_000)).toBeNull()
    expect(freshGatePick({ ...pick, category: 'voice' as never }, 1_000)).toBeNull()
  })
})
