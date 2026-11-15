// @vitest-environment jsdom
/**
 * Die Modellwaehler der Cloud ordnen nach Stufe und nennen die Herkunft.
 *
 * 02.10.2026, Entscheid des Inhabers: "Best" steht oben und traegt eine kleine
 * Marke, aeltere Modelle stehen gesammelt unten unter "Older models", nichts
 * wird versteckt. Die Herkunft steht dezent daneben ("Open weights"), sobald
 * die Familie offene Gewichte hat.
 *
 * 05.10.2026: die Cloud-Waehler gruppieren nach Familie, mit denselben
 * einzeiligen Gruppenkoepfen wie die Modellauswahl im Chat. Beides gilt
 * zusammen (lib/render/model-tier, groupForPicker): Familien zuerst, die mit
 * einem "Best" vorn, in jeder Gruppe die Besten zuerst, einzelne Modelle
 * unter "Other", die Aelteren weiter gesammelt am Ende.
 *
 * Desktop: der Katalog kommt vom Server. Die Faelle laufen gegen den Katalog
 * des neuen Servers (mit Stufe, Herkunft und den neuen Modellen) und gegen den
 * des alten (ohne beides): dort steht jede Zeile neutral da, ohne Marke und
 * ohne Zwischenzeile, in der gewohnten Reihenfolge.
 *
 * Harte Regel: KEIN Hinweis, keine Marke, kein Text im oder ueber dem
 * Prompt-Eingabefeld. Die Marken gehoeren in die aufgeklappten Modellwaehler
 * und nirgends sonst hin; die letzten Faelle halten das am Quelltext fest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../../../hooks/useContentPolicy', () => ({
  useContentPolicy: () => 'soft' as const,
  primeContentPolicyCache: vi.fn(),
}))

import { ModelChip } from '../ModelChip'
import { useCreateStore, type CreateIntent } from '../../../../stores/createStore'
import {
  animatePickerModels, cloudModelsFor, editCapableModels, studioOnlyImageModels, useCloudCatalogStore, videoPickerModels,
} from '../../../../stores/cloudCatalogStore'
import { groupForPicker, tierOf, OLDER_GROUP, OTHER_GROUP } from '../../../../lib/render/model-tier'
import { alterServer, neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'

beforeEach(() => {
  cleanup()
  // jsdom kennt kein ResizeObserver, das die aufgeklappte Liste beobachtet.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  useCreateStore.setState({ backend: 'cloud', cloudImageModel: '', cloudVideoModel: '', cloudOpModel: '' })
  useCloudCatalogStore.setState({ models: neuerServer() })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Oeffnet den Waehler und liest die Liste so, wie ein Kunde sie sieht. */
function lies(intent: CreateIntent) {
  useCreateStore.getState().setIntent(intent)
  render(<ModelChip />)
  fireEvent.click(screen.getByRole('button'))
  const liste = document.querySelector('.lu-elevated') as HTMLElement | null
  if (!liste) throw new Error('Liste nicht offen')
  const zeilen = Array.from(liste.querySelectorAll('button')).map((b) => ({
    name: (b.querySelector('.truncate')?.textContent ?? '').trim(),
    best: Array.from(b.querySelectorAll('span')).some((s) => s.textContent === 'Best'),
    offen: Array.from(b.querySelectorAll('span')).some((s) => s.textContent === 'Open weights'),
    familie: Array.from(b.querySelectorAll('span')).some((s) => s.textContent === 'Open family'),
  }))
  // Die Gruppenkoepfe in ihrer Reihenfolge, je mit Name und Anzahl.
  const koepfe = Array.from(liste.querySelectorAll('.lu-picker-head')).map((k) => ({
    name: k.querySelector('b')?.textContent ?? '',
    anzahl: Number(k.querySelector('.n')?.textContent),
  }))
  const kopf = koepfe.find((k) => k.name === OLDER_GROUP)
  return { liste, zeilen, kopf, koepfe }
}

/** Die Namen in der Reihenfolge, in der der Waehler sie zeigen soll. */
const reihenfolge = <T extends { label: string }>(liste: readonly T[]) =>
  groupForPicker(liste).map((e) => e.model.label)

describe('der Bildwaehler (neuer Server)', () => {
  it('gruppiert nach Familie, fuehrt in jeder Gruppe die Besten und sammelt die Aelteren unter einer Zwischenzeile', () => {
    const katalog = [...cloudModelsFor('image'), ...studioOnlyImageModels()]
    const erwartet = groupForPicker(katalog)
    const { zeilen, kopf, koepfe } = lies('image')
    expect(zeilen.map((z) => z.name)).toEqual(erwartet.map((e) => e.model.label))
    // Kein Modell fehlt und keines steht doppelt.
    expect(zeilen).toHaveLength(katalog.length)

    // Jedes Beste traegt die Marke, und nur die Besten tragen sie.
    const beste = katalog.filter((m) => m.tier === 'best').map((m) => m.label)
    expect(beste.length).toBeGreaterThanOrEqual(2)
    expect(zeilen.filter((z) => z.best).map((z) => z.name).sort()).toEqual([...beste].sort())
    expect(beste).toEqual(expect.arrayContaining(['Z-Image Turbo (fast)', 'Z-Image Base']))

    // Die Koepfe: Familien mit mehr als einem Modell, dann Other, zuletzt die
    // Aelteren. Jeder Kopf nennt, wie viele Zeilen unter ihm stehen.
    const namen = koepfe.map((k) => k.name)
    expect(namen).toEqual([...new Set(erwartet.map((e) => e.group))])
    expect(namen).toContain('Z-Image')
    expect(namen.at(-1)).toBe(OLDER_GROUP)
    expect(namen.at(-2)).toBe(OTHER_GROUP)
    for (const k of koepfe) {
      expect(k.anzahl, k.name).toBe(erwartet.filter((e) => e.group === k.name).length)
      if (k.name !== OTHER_GROUP && k.name !== OLDER_GROUP) expect(k.anzahl, k.name).toBeGreaterThan(1)
    }
    expect(koepfe.reduce((n, k) => n + k.anzahl, 0)).toBe(zeilen.length)

    // Die erste Familie ist die des ersten Besten, und sie beginnt mit ihm.
    expect(zeilen[0].best).toBe(true)
    // In keiner Gruppe steht ein Bestes hinter einem, das es nicht ist.
    for (const k of koepfe) {
      const gruppe = erwartet.filter((e) => e.group === k.name).map((e) => zeilen.find((z) => z.name === e.model.label)!.best)
      expect(gruppe.join(), k.name).toBe([...gruppe].sort((a, b) => Number(b) - Number(a)).join())
    }

    const aelter = erwartet.filter((e) => tierOf(e.model) === 'older').map((e) => e.model.label)
    // HiDream und HunyuanImage 2.1 stehen seit dem 24.10.2026 in keinem
    // Waehler mehr (retired-models.ts).
    expect(aelter).toEqual(expect.arrayContaining(['Flux Schnell (fast)', 'Flux Dev (quality)', 'Qwen Image', 'Wan 2.2 Realism']))
    expect(zeilen.slice(-aelter.length).map((z) => z.name)).toEqual(aelter)
    expect(kopf).toBeTruthy()
    const ersteAlte = zeilen[zeilen.length - aelter.length].name
    const knoepfe = Array.from(document.querySelectorAll('.lu-elevated button'))
    const mitKopf = knoepfe.filter((b) => b.previousElementSibling?.querySelector('b')?.textContent === OLDER_GROUP)
    expect(mitKopf).toHaveLength(1)
    expect(mitKopf[0].querySelector('.truncate')?.textContent).toBe(ersteAlte)
  })

  it('der Kopf ist die eine Zeile der Modellauswahl im Chat, die Zeile ihre Zeile', () => {
    const { liste } = lies('image')
    expect(liste.className).toContain('lu-picker')
    expect(liste.querySelectorAll('.lu-picker-head').length).toBeGreaterThan(2)
    const knoepfe = Array.from(liste.querySelectorAll('button'))
    for (const b of knoepfe) expect(b.className).toContain('lu-picker-row')
    // Die gewaehlte Zeile sagt es einer Bedienhilfe, genau eine.
    expect(knoepfe.filter((b) => b.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    // Marken im Etiketten-Stil, "Best" im einen Akzent.
    const best = Array.from(liste.querySelectorAll('span')).find((x) => x.textContent === 'Best')!
    expect(best.className).toContain('lu-picker-tag')
    expect(best.className).toContain('is-accent')
    const offen = Array.from(liste.querySelectorAll('span')).find((x) => x.textContent === 'Open weights')!
    expect(offen.className).toContain('lu-picker-tag')
    expect(offen.className).not.toContain('is-accent')
  })

  it('nennt die Herkunft nur dort, wo die Familie offene Gewichte hat', () => {
    const { zeilen } = lies('image')
    const von = (name: string) => zeilen.find((z) => z.name === name)!
    expect(von('Nucleus').familie).toBe(true)
    expect(von('Nucleus').offen).toBe(false)
    expect(von('Qwen Image 2.1').offen).toBe(true)
    expect(von('Qwen Image 2.1').familie).toBe(false)
    expect(von('Z-Image Base').offen).toBe(true)
    expect(von('Flux Schnell (fast)').offen).toBe(true)
  })

  it('der geschlossene Waehler zeigt keine Marke: sie stehen nur in der aufgeklappten Liste', () => {
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ cloudImageModel: 'z-image-turbo' })
    render(<ModelChip />)
    expect(screen.queryByText('Best')).toBeNull()
    expect(screen.queryByText('Open weights')).toBeNull()
    expect(screen.queryByText(OLDER_GROUP)).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByText('Best').length).toBeGreaterThan(0)
  })
})

describe('die anderen Waehler (neuer Server)', () => {
  it('Bearbeiten: Beste oben, geschlossene tragen nur "Best" und keine Herkunft', () => {
    const { zeilen } = lies('edit')
    expect(zeilen.map((z) => z.name)).toEqual(reihenfolge(editCapableModels()))
    const seedream = zeilen.find((z) => z.name === 'Seedream 5 Pro')!
    expect(seedream.best).toBe(true)
    expect(seedream.offen).toBe(false)
    expect(zeilen.at(-1)!.name).toBe('Qwen Image Edit (no mask needed)')
  })

  it('Video: die neuen Modelle stehen im Waehler, die alten Wan, LTX und Hunyuan unten', () => {
    const { zeilen } = lies('video')
    expect(zeilen.map((z) => z.name)).toEqual(reihenfolge(videoPickerModels()))
    expect(zeilen[0].best).toBe(true)
    // Wan 3.0 mit Text zu Video seit dem 24.10.2026; LTX 2.3 und
    // HunyuanVideo 1.5 stehen seither in keinem Waehler mehr.
    expect(zeilen.filter((z) => z.best).map((z) => z.name)).toEqual(['Wan 3.0', 'LTX 2.5', 'MiniMax H3'])
    const unten = zeilen.slice(-5).map((z) => z.name)
    expect(unten).toEqual(expect.arrayContaining(['Wan 2.2 720p', 'Wan 2.2 Fast']))
    expect(zeilen.map((z) => z.name)).not.toContain('LTX 2.3')
  })

  it('Animate: Referenzmodelle und die neuen Bild-zu-Video-Modelle sind waehlbar', () => {
    const { zeilen } = lies('animate')
    expect(zeilen.map((z) => z.name)).toEqual(reihenfolge(animatePickerModels()))
    for (const name of ['LTX 2.5', 'MiniMax H3 • Reference', 'Wan 3.0 • Reference']) {
      expect(zeilen.map((z) => z.name), name).toContain(name)
    }
  })
})

describe('gegen den Server von heute (ohne Stufe, ohne die neuen Modelle)', () => {
  beforeEach(() => { useCloudCatalogStore.setState({ models: alterServer() }) })

  it('der Bildwaehler traegt keine Marke und keine "Older models", nur die Familien', () => {
    // Die Familie steht im Namen, also gruppiert der Waehler auch gegen einen
    // Server, der noch keine Stufe schickt. Ohne Stufe bleibt in jeder Familie
    // die Reihenfolge des Katalogs.
    const katalog = [...cloudModelsFor('image'), ...studioOnlyImageModels()]
    const { zeilen, kopf } = lies('image')
    expect(zeilen.map((z) => z.name)).toEqual(reihenfolge(katalog))
    expect(zeilen.map((z) => z.name).sort()).toEqual(katalog.map((m) => m.label).sort())
    expect(zeilen.length).toBeGreaterThan(5)
    for (const z of zeilen) {
      expect(z.best, z.name).toBe(false)
      expect(z.offen, z.name).toBe(false)
      expect(z.familie, z.name).toBe(false)
    }
    expect(kopf).toBeUndefined()
    expect(zeilen.map((z) => z.name)).not.toContain('Qwen Image 2.1')
  })

  it('Video, Animate und Bearbeiten stehen ebenso neutral, ohne ein neues Modell', () => {
    for (const intent of ['video', 'animate', 'edit'] as const) {
      cleanup()
      const { zeilen, kopf } = lies(intent)
      expect(zeilen.length, intent).toBeGreaterThan(1)
      for (const z of zeilen) expect(z.best || z.offen || z.familie, `${intent}/${z.name}`).toBe(false)
      expect(kopf, intent).toBeUndefined()
      expect(zeilen.map((z) => z.name), intent).not.toContain('LTX 2.5')
      expect(zeilen.map((z) => z.name), intent).not.toContain('Qwen Image 2.1 Edit')
    }
  })
})

describe('im und ueber dem Prompt-Feld steht nichts davon', () => {
  const lese = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

  it('weder das Promptfeld noch der Composer kennen die Marken', () => {
    for (const rel of ['src/components/create/ui/PromptField.tsx', 'src/components/create/experimental/Composer.tsx']) {
      const src = lese(rel)
      expect(src, rel).not.toMatch(/tierMarks|model-tier|Open weights|Older models/)
      expect(src, rel).not.toMatch(/['"`>]Best['"`<]/)
    }
  })

  it('die Marken kommen nur aus dem Waehler und aus dem Modellfeld des Presets', () => {
    const treffer = ['src/components/create/experimental/ModelChip.tsx', 'src/components/create/experimental/PresetWorkshop.tsx']
    for (const rel of treffer) expect(lese(rel), rel).toMatch(/tierMarks/)
  })
})

// How-to recording 12.10.2026: on "Use character" the chip said "Select..."
// while no character was picked, and there was no model to select.
describe('the chip on "Use character" before a character is picked', () => {
  it('names the step that is missing', () => {
    useCreateStore.getState().setIntent('character')
    useCreateStore.setState({ characterTab: 'use', selectedCharacter: null })
    render(<ModelChip />)
    expect(screen.getByRole('button').textContent).toContain('Pick a character first')
    expect(screen.getByRole('button').textContent).not.toContain('Select...')
  })
})
