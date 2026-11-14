// Stufe und Herkunft jedes Cloud-Modells (02.10.2026, Entscheid des Inhabers),
// im Desktop.
//
// `tier` ordnet die Waehler, `weights` sagt, woher das Modell stammt. Im Web
// traegt jedes Modell beides. Der Desktop hat zwei Quellen: den Notvorrat
// (CLOUD_MODEL_SEED, ohne Netz) und die mitgelieferte Studio-Registrierung
// (studio-models.json, gehalten gegen das Web). Beide muessen vollstaendig sein,
// sonst steht ein Modell ungeordnet und ohne Herkunft im Waehler, sobald der
// Server die Felder liefert.

import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOUD_MODEL_SEED } from '../cloud-models'
import { STUDIO_MODELS, STUDIO_MODELS_WITH_RETIRED } from '../studio-contract'
import { isRetiredMediaModel } from '../retired-models'
import { intentPickerModels } from '../create-studio'
import { presetModels } from '../preset-models'
import { sortByTier } from '../model-tier'
import {
  animatePickerModels, cloudModelsFor, editCapableModels, studioOnlyImageModels, useCloudCatalogStore, videoPickerModels,
} from '../../../stores/cloudCatalogStore'
import { neuerServer } from './fixtures/test-catalogs'
import katalogVor from './fixtures/katalog-vor-02-10-2026.json'

const TIERS = ['best', 'standard', 'older']
const WEIGHTS = ['open', 'open-family', 'closed']

describe('jedes Cloud-Modell traegt Stufe und Herkunft', () => {
  it('kein Eintrag des Notvorrats ohne beide Felder, und beide Werte sind erlaubt', () => {
    expect(CLOUD_MODEL_SEED.length).toBeGreaterThan(40)
    for (const m of CLOUD_MODEL_SEED) {
      expect(TIERS, `${m.id}.tier`).toContain(m.tier)
      expect(WEIGHTS, `${m.id}.weights`).toContain(m.weights)
    }
  })

  it('kein Studio-Eintrag der Registrierung ohne beide Felder, auch nicht im Rohtext', () => {
    const roh = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/render/studio-models.json'), 'utf8')) as Record<string, { tier?: string; weights?: string }>
    for (const [id, m] of Object.entries(roh)) {
      expect(TIERS, `${id}.tier`).toContain(m.tier)
      expect(WEIGHTS, `${id}.weights`).toContain(m.weights)
    }
    expect(Object.keys(roh)).toEqual(Object.keys(STUDIO_MODELS_WITH_RETIRED))
  })

  it('der Katalog des neuen Servers traegt beide Felder an jedem Eintrag', () => {
    const katalog = neuerServer()
    expect(katalog.length).toBeGreaterThan(100)
    for (const m of katalog) {
      expect(TIERS, `${m.id}.tier`).toContain(m.tier)
      expect(WEIGHTS, `${m.id}.weights`).toContain(m.weights)
    }
  })

  it('ein Studio-Zwilling traegt dieselbe Einstufung wie sein klassischer Bruder', () => {
    const zwillinge = Object.entries(STUDIO_MODELS).filter(([, m]) => m.sourceModel)
    expect(zwillinge.length).toBeGreaterThan(0)
    for (const [id, m] of zwillinge) {
      const klassisch = CLOUD_MODEL_SEED.find((c) => c.id === m.sourceModel)!
      expect(klassisch, id).toBeDefined()
      expect({ tier: m.tier, weights: m.weights }, id).toEqual({ tier: klassisch.tier, weights: klassisch.weights })
    }
  })

  it('stuft die benannten Modelle so ein, wie der Inhaber es vorgegeben hat', () => {
    const t = (id: string) => neuerServer().find((m) => m.id === id)!
    for (const id of ['minimax-h3', 'wan-3.0', 'z-image', 'z-image-turbo', 'seedance-2.5']) expect(t(id).tier, id).toBe('best')
    // hidream, hunyuan-image, ltx-2.3, hunyuan-video, eleven-v3 und
    // pixverse-extend standen hier auch. Seit dem 24.10.2026 stehen sie in
    // keinem Waehler mehr (retired-models.ts).
    for (const id of ['flux-schnell', 'flux-dev', 'qwen-image', 'wan-2.2-720p', 'wan-2.2-fast', 'ltx-2']) {
      expect(t(id).tier, id).toBe('older')
    }
    for (const id of ['wan-3.0', 'wan-3.0-ref', 'qwen-image-3-edit', 'flux-3-upscale']) expect(t(id).weights, id).toBe('open-family')
    for (const id of ['seedance-2.5', 'seedance-2.5-spicy', 'seedream-5-edit', 'vidu-q3-spicy', 'heygen-twin', 'mureka-song', 'minimax-music', 'minimax-speech-hd', 'lipsync-3-avatar', 'lipsync-2']) {
      expect(t(id).weights, id).toBe('closed')
    }
    for (const id of ['minimax-h3', 'z-image', 'ltx-2.5-t2v', 'qwen-image-2.1', 'qwen-image-2.1-edit']) expect(t(id).weights, id).toBe('open')
  })

  it('der Katalog behaelt alles, was er hatte: entfernt ist nur, was das Web zurueckgezogen hat', () => {
    const jetzt = new Set(neuerServer().map((m) => m.id))
    expect(katalogVor.length).toBeGreaterThan(100)
    // Am 24.10.2026 hat das Web neun Modelle aus den Waehlern genommen
    // (retired-models.ts). Nur die duerfen fehlen, und sie muessen fehlen.
    for (const id of katalogVor) expect(jetzt.has(id), id).toBe(!isRetiredMediaModel(id))
    expect(katalogVor.filter((id) => isRetiredMediaModel(id))).toHaveLength(9)
  })
})

describe('die Waehler ordnen nach Stufe', () => {
  beforeEach(() => { useCloudCatalogStore.setState({ models: neuerServer() }) })

  const WAEHLER: Record<string, () => { id: string; tier?: 'best' | 'standard' | 'older' }[]> = {
    image: () => [...cloudModelsFor('image'), ...studioOnlyImageModels()],
    edit: () => editCapableModels(),
    video: () => videoPickerModels(),
    animate: () => animatePickerModels(),
    music: () => intentPickerModels('music'),
    extend: () => intentPickerModels('extend'),
    video_upscale: () => intentPickerModels('video_upscale'),
    restyle: () => presetModels('restyle'),
  }

  for (const [name, liste] of Object.entries(WAEHLER)) {
    it(`im Waehler ${name}: Beste zuerst, Aeltere zuletzt, kein Modell fehlt`, () => {
      const roh = liste()
      const sortiert = sortByTier(roh)
      expect(sortiert).toHaveLength(roh.length)
      expect(new Set(sortiert.map((m) => m.id))).toEqual(new Set(roh.map((m) => m.id)))
      const rang = sortiert.map((m) => ['best', 'standard', 'older'].indexOf(m.tier ?? 'standard'))
      expect(rang).toEqual([...rang].sort((a, b) => a - b))
    })
  }

  it('die Waehler haben beides, damit die Sortierung etwas bewirkt', () => {
    const tiers = new Set(WAEHLER.video().map((m) => m.tier))
    expect(tiers.has('best') && tiers.has('older')).toBe(true)
    const bild = new Set(WAEHLER.image().map((m) => m.tier))
    expect(bild.has('best') && bild.has('older')).toBe(true)
  })
})
