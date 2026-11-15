/**
 * @vitest-environment jsdom
 *
 * Der Model Manager ordnet seine Bild- und Video-Bundles nach Stufe
 * (02.10.2026): "Best" steht oben und traegt eine kleine Marke, die
 * aelteren Modelle stehen gesammelt unten unter "Older models", nichts wird
 * versteckt. Dieselbe Regel und dieselbe Optik wie in den Cloud-Waehlern
 * (lib/render/model-tier.ts).
 *
 * Gemessen an der gerenderten Seite, nicht am Quelltext.
 *
 * Run: npx vitest run src/components/models/__tests__/die-stufen-im-model-manager.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  backendCall: vi.fn(async () => []),
  openExternal: vi.fn(),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../../../api/comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/comfyui')>()),
  getSystemVRAM: vi.fn(async () => 24),
  readComfyFolderLists: vi.fn(async () => ({})),
  refreshComfyModels: vi.fn(async () => {}),
}))
vi.mock('../../../lib/hardware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/hardware')>()),
  getMaxVramGb: vi.fn(async () => 24),
  getTotalRamGb: vi.fn(async () => 64),
}))
vi.mock('../CivitaiSearchPanel', () => ({ CivitaiSearchPanel: () => null }))
vi.mock('../../chat/LuEngineSwitchBar', () => ({ LuEngineSwitchBar: () => null }))

import { DiscoverModels } from '../DiscoverModels'
import { getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles } from '../../../api/model-bundles'
import { OLDER_GROUP } from '../../../lib/render/model-tier'

beforeEach(() => {
  cleanup()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Die Karten in der Reihenfolge, in der der Kunde sie sieht, samt Zwischenzeile. */
function lies() {
  const raster = document.querySelector('.grid') as HTMLElement
  const kinder = Array.from(raster.children) as HTMLElement[]
  const reihe: Array<{ typ: 'kopf' | 'karte'; text: string; best?: boolean }> = []
  for (const k of kinder) {
    const gruppe = k.getAttribute('data-tier-group')
    if (gruppe) { reihe.push({ typ: 'kopf', text: gruppe }); continue }
    const name = k.querySelector('[data-bundle-tile]')?.getAttribute('data-bundle-tile') ?? ''
    const best = Array.from(k.querySelectorAll('h3 ~ span')).some((s) => s.textContent === 'Best')
    reihe.push({ typ: 'karte', text: name, best })
  }
  return reihe
}

describe('der Video-Reiter', () => {
  it('fuehrt die Besten oben mit "Best", sammelt die Aelteren unter "Older models"', async () => {
    render(<DiscoverModels category="video" />)
    await waitFor(() => expect(document.querySelectorAll('[data-bundle-tile]').length).toBeGreaterThan(5))
    const reihe = lies()
    const karten = reihe.filter((r) => r.typ === 'karte')
    const alle = [...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles()]
    const mainstream = alle.filter((b) => !b.uncensored)
    expect(karten.map((r) => r.text).sort()).toEqual(mainstream.map((b) => b.name).sort())

    const tierVon = (name: string) => alle.find((b) => b.name === name)!.tier
    const rank = { best: 0, standard: 1, older: 2 }
    const ranks = karten.map((r) => rank[tierVon(r.text)])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))

    // Marke "Best" genau an den Besten, an keiner anderen.
    for (const k of karten) expect(k.best, k.text).toBe(tierVon(k.text) === 'best')
    const best = karten.filter((k) => k.best).map((k) => k.text)
    expect(best).toEqual(expect.arrayContaining([
      'LTX 2.5 · Video with Sound', 'MiniMax H3 · Start/End Frames, with Sound', 'FastH3 · MiniMax H3 in 8 Steps',
    ]))

    // Genau eine Zwischenzeile, direkt vor der ersten aelteren Karte.
    const koepfe = reihe.filter((r) => r.typ === 'kopf')
    expect(koepfe).toEqual([{ typ: 'kopf', text: OLDER_GROUP }])
    const i = reihe.findIndex((r) => r.typ === 'kopf')
    expect(tierVon(reihe[i + 1].text)).toBe('older')
    expect(tierVon(reihe[i - 1].text)).not.toBe('older')
    // Der alte LTX steht unten, nicht verschwunden.
    expect(karten.map((r) => r.text).slice(i)).toContain('LTX Video 2.3 · 22B FP8')
  })
})

describe('die anderen Create-Spuren sind im Video-Reiter installierbar', () => {
  // 02.10.2026: Musik, Lip Sync und Motion gab es nur ueber die Startkarte der
  // leeren Spur. Ein zweites Musikmodell (YuE2 neben ACE) oder die FP8-Variante
  // von S2V liess sich danach nie mehr holen.
  it('YuE2, ACE v1 und S2V FP8 haben eine Karte mit Spur-Marke und Get-Knopf', async () => {
    render(<DiscoverModels category="video" />)
    await waitFor(() => expect(document.querySelectorAll('[data-bundle-tile]').length).toBeGreaterThan(5))
    const karte = (teil: string) => {
      const el = Array.from(document.querySelectorAll('[data-bundle-tile]')).find((e) => (e.getAttribute('data-bundle-tile') ?? '').includes(teil))
      if (!el) throw new Error(`keine Karte fuer ${teil}`)
      return el as HTMLElement
    }
    for (const [teil, spur] of [['YuE2', 'Music'], ['ACE Step v1', 'Music'], ['S2V FP8', 'Lip sync'], ['Animate Q4', 'Motion']] as const) {
      const k = karte(teil)
      expect(k.querySelector('[data-bundle-lane]')?.getAttribute('data-bundle-lane'), teil).toBe(spur)
      expect(Array.from(k.querySelectorAll('button')).some((b) => /^Get/.test((b.textContent ?? '').trim())), teil).toBe(true)
    }
    // Die Videokarten tragen keine Spur-Marke.
    expect(karte('LTX 2.5 · Video with Sound').querySelector('[data-bundle-lane]')).toBeNull()
  })
})

describe('der Bild-Reiter', () => {
  it('Qwen-Image 2.1, Z-Image, FLUX 2, ERNIE oben, die SDXL-Klassiker und FLUX 1 unten', async () => {
    render(<DiscoverModels category="image" />)
    await waitFor(() => expect(document.querySelectorAll('[data-bundle-tile]').length).toBeGreaterThan(3))
    const reihe = lies()
    const karten = reihe.filter((r) => r.typ === 'karte')
    const mainstream = getImageBundles().filter((b) => !b.uncensored)
    expect(karten.map((r) => r.text).sort()).toEqual(mainstream.map((b) => b.name).sort())
    const i = reihe.findIndex((r) => r.typ === 'kopf')
    const oben = reihe.slice(0, i).map((r) => r.text)
    expect(oben).toEqual(expect.arrayContaining(['Qwen-Image 2.1 (Generate and Edit)', 'FLUX 2 Klein 4B (Next Gen)']))
    const unten = reihe.slice(i + 1).map((r) => r.text)
    expect(unten).toEqual(expect.arrayContaining(['FLUX.1 [dev] FP8 (High Quality)']))
    expect(screen.getByText(OLDER_GROUP)).toBeTruthy()
  })
})
