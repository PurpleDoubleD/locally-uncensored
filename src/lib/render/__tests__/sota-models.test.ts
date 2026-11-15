// Die Modelle aus offenen Familien, aufgenommen am 02.10.2026, im Desktop.
//
// Regel vom Inhaber: neu aufgenommen wird nur, was aus einer Familie stammt, die
// je offene Gewichte veroeffentlicht hat. Bestehende Modelle bleiben, auch
// geschlossene. Entscheid vom 06.10.2026: ausgeliefert werden Wan 3.0
// Reference, LTX 2.5, MiniMax H3 und Qwen Image 2.1 samt Edit. Dieser Fall
// haelt fest, dass jedes dieser Modelle im Cloud-Modus des Desktops wirklich
// ankommt: mit Schema, mit einem Preis,
// in genau einer Rolle und an der Stelle, an der der Kunde
// es waehlen kann. Der Desktop liest den Katalog vom Server: alle Waehler-Faelle
// laufen darum gegen den Katalog des neuen Servers (neuerServer), und der
// Gegenfall gegen den alten steht in alter-server.test.ts.
//
// Aus dem Web uebernommen, ohne die Faelle, die Serverdateien lesen.

import { beforeEach, describe, expect, it } from 'vitest'
import { STUDIO_MODELS, studioCredits, studioOptions, studioSchema, studioFields } from '../studio-contract'
import { editNeedsMask } from '../../../stores/cloudCatalogStore'
import {
  animatePickerModels, cloudModelById, editCapableModels, modelForOp, studioOnlyImageModels, useCloudCatalogStore,
  utilityOpModel, videoPickerModels, cloudModelsFor,
} from '../../../stores/cloudCatalogStore'
import { ALL_ROLES, presetModels, roleForModel } from '../preset-models'
import { intentPickerModels } from '../create-studio'
import { neuerServer } from './fixtures/test-catalogs'
import prices from './fixtures/studio-prices-2026-10-02.json'

/** Rechnet eine Zeile der Preistabelle in Credits um. */
const CREDIT_USD = 1e-5

/** Jedes Modell dieser Aufnahme, mit dem Endpunkt, den der Anbieter listet. */
const NEU: Record<string, string> = {
  'qwen-image-2.1': 'base/qwen-image-2.1/text-to-image',
  'qwen-image-2.1-edit': 'base/qwen-image-2.1/edit',
  'ltx-2.5-t2v': 'base/ltx-2.5/text-to-video',
  'ltx-2.5-i2v': 'base/ltx-2.5/image-to-video',
  'minimax-h3-t2v': 'base/minimax-h3/text-to-video',
  'minimax-h3-ref': 'base/minimax-h3/reference-to-video',
  'minimax-h3-video-edit': 'base/minimax-h3/video-edit',
  'wan-3.0-ref': 'alibaba/wan-3.0/reference-to-video',
}

beforeEach(() => {
  useCloudCatalogStore.setState({ models: neuerServer() })
})

describe('die neuen Modelle aus offenen Familien', () => {
  it('sind alle in der Registrierung und im Katalog des neuen Servers, mit dem Endpunkt des Anbieters', () => {
    expect(Object.keys(NEU)).toHaveLength(8)
    for (const [id, endpoint] of Object.entries(NEU)) {
      expect(STUDIO_MODELS[id], id).toBeDefined()
      expect(STUDIO_MODELS[id].endpoint, id).toBe(endpoint)
      expect(cloudModelById(id), id).toBeDefined()
    }
  })

  it('stehen nicht doppelt: kein Endpunkt zweimal, auch nicht unter altem Namen', () => {
    const endpoints = Object.values(STUDIO_MODELS).map((m) => m.endpoint)
    expect(new Set(endpoints).size).toBe(endpoints.length)
    expect(STUDIO_MODELS['qwen-image-3-edit'].endpoint).toBe('alibaba/qwen-image-3.0/edit')
    expect(Object.values(NEU)).not.toContain('alibaba/qwen-image-3.0/edit')
    expect(Object.values(NEU)).not.toContain('base/minimax-h3/image-to-video')
    expect(Object.values(NEU)).not.toContain('alibaba/wan-3.0/image-to-video')
    expect(Object.values(NEU)).not.toContain('black-forest-labs/flux-3/video-upscale')
  })

  it('haben ein Schema, einen Grundpreis und tragen keine Freigabe-Marke', () => {
    for (const id of Object.keys(NEU)) {
      const m = STUDIO_MODELS[id]
      expect(studioSchema(id).properties, id).toBeTruthy()
      expect(m.baselineUsd, id).toBeGreaterThan(0)
      // Die Familien sind offen, die Endpunkte gefiltert: kein No-refusals-Flag.
      expect(m.adult, id).toBe(false)
      // Mit den Vorgaben allein ist das Modell startbereit.
      expect(() => studioOptions(id, 'a test prompt', {}), id).not.toThrow()
      expect(studioCredits(id, studioOptions(id, 'a test prompt', {}), 5, 1, 100), id).toBeGreaterThan(0)
    }
  })

  it('geben jedem Eingabefeld ein echtes Feld des Anbieterschemas', () => {
    for (const id of Object.keys(NEU)) {
      for (const field of Object.keys(STUDIO_MODELS[id].inputs)) {
        expect(studioSchema(id).properties, `${id}.${field}`).toHaveProperty(field)
      }
      for (const field of Object.keys(STUDIO_MODELS[id].defaults)) {
        expect(studioSchema(id).properties, `${id}.${field}`).toHaveProperty(field)
      }
    }
  })

  it('bepreisen jeden Wert des Preisfeldes, sonst bliebe ein Wert ohne Preis', () => {
    for (const id of Object.keys(STUDIO_MODELS)) {
      const m = STUDIO_MODELS[id]
      const field = m.price.resolutionField ?? 'resolution'
      const values = studioSchema(id).properties?.[field]?.enum
      if (!values || m.price.rates.default !== undefined) continue
      // Mit `qualityField` (GPT Image 2) steht der Satz unter
      // "<Aufloesung>/<Qualitaet>": jedes Paar braucht einen.
      const quality = m.price.qualityField ? studioSchema(id).properties?.[m.price.qualityField]?.enum ?? [] : [undefined]
      for (const v of values) for (const q of quality) {
        const key = q === undefined ? String(v) : `${String(v)}/${String(q)}`
        expect(m.price.rates[key], `${id}: ${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('gehoeren zu genau einer Rolle, und jede Rolle kennt sie', () => {
    for (const id of Object.keys(NEU)) {
      const rollen = ALL_ROLES.filter((r) => presetModels(r).some((m) => m.id === id))
      expect(rollen, id).toHaveLength(1)
      expect(roleForModel(id), id).toBe(rollen[0])
    }
  })
})

describe('der Preis folgt der Preistabelle', () => {
  const EXAKT_AUSNAHME = new Set(['qwen-image-2.1-edit', 'minimax-h3-ref'])
  it.each(prices)('$model $options: Credits decken die Zeile der Tabelle', (row) => {
    const options = studioOptions(row.model, '', row.options, false)
    const credits = studioCredits(row.model, options, (row as { seconds?: number }).seconds, (row as { imageCount?: number }).imageCount ?? 1, row.promptLength)
    const einkauf = Math.round(row.usd / CREDIT_USD)
    expect(credits).toBeGreaterThanOrEqual(einkauf)
    if (EXAKT_AUSNAHME.has(row.model)) expect(credits).toBeLessThanOrEqual(Math.ceil(einkauf * 1.6))
    else expect(credits).toBe(einkauf)
  })

  it('bucht dieselbe Creditzahl wie bei vergleichbaren Modellen: eins zu eins zur Tabelle', () => {
    const alt = studioCredits('minimax-h3', studioOptions('minimax-h3', 'x', { duration: 5, resolution: '480p' }))
    const neu = studioCredits('minimax-h3-t2v', studioOptions('minimax-h3-t2v', 'x', { duration: 5, resolution: '480p' }))
    expect(alt).toBe(Math.round(0.2 / CREDIT_USD))
    expect(neu).toBe(alt)
    expect(studioCredits('wan-3.0', studioOptions('wan-3.0', 'x', { duration: 5, resolution: '720p' })))
      .toBe(studioCredits('wan-3.0-ref', studioOptions('wan-3.0-ref', 'x', { duration: 5, resolution: '720p' })))
  })
})

describe('der Kunde kann sie dort waehlen, wo sie hingehoeren', () => {
  const ids = (list: { id: string }[]) => list.map((m) => m.id)

  it('Text zu Bild: Qwen Image 2.1 steht im Bildwaehler', () => {
    expect(ids(studioOnlyImageModels())).toContain('qwen-image-2.1')
  })

  it('Bearbeiten: die Editoren stehen im Edit-Waehler und laufen ohne Maske', () => {
    const edit = ids(editCapableModels())
    expect(edit).toContain('qwen-image-2.1-edit')
    expect(modelForOp('image', 'edit', 'qwen-image-2.1-edit')).toBe('qwen-image-2.1-edit')
    expect(modelForOp('image', 'edit', 'nonsense')).toBe('qwen-image-2.1-edit')
  })

  it('Text zu Video: im Video-Waehler, und eine Wahl bleibt beim Start bestehen', () => {
    const video = ids(videoPickerModels())
    for (const id of ['ltx-2.5-t2v', 'minimax-h3-t2v']) {
      expect(video, id).toContain(id)
      expect(modelForOp('video', 'generate', id), id).toBe(id)
    }
    // Die klassischen Modelle stehen weiter vorn und haben ihre Wahl behalten.
    expect(video[0]).toBe('wan-2.2-720p')
    expect(modelForOp('video', 'generate', 'wan-2.2-fast')).toBe('wan-2.2-fast')
  })

  it('Bild zu Video: im Animate-Waehler, samt der Referenzmodelle', () => {
    const animate = ids(animatePickerModels())
    for (const id of ['ltx-2.5-i2v', 'minimax-h3-ref', 'wan-3.0-ref']) {
      expect(animate, id).toContain(id)
      expect(modelForOp('video', 'animate', id), id).toBe(id)
    }
    expect(animate).not.toContain('ltx-2.5-t2v')
  })

  it('Restyle: MiniMax H3 Video Edit steht neben Wan DITTO', () => {
    expect(ids(presetModels('restyle'))).toEqual(['wan-ditto', 'minimax-h3-video-edit'])
  })

  it('Bild-Upscale hat keinen eigenen Waehler: ein Studio-Bildmodell aus dem Bild-Tab wird umgebogen', () => {
    expect(intentPickerModels('upscale')).toEqual([])
    expect(utilityOpModel('image', 'upscale', 'qwen-image-2.1')).not.toBe('qwen-image-2.1')
    expect(utilityOpModel('image', 'removebg', 'qwen-image-2.1')).not.toBe('qwen-image-2.1')
  })

  it('jedes Eingabefeld, das die Oberflaeche nicht fuellt, ist ein Feld mit Vorgabe oder ohne Pflicht', () => {
    // In Create faellt nur ein Bild an. Jedes Modell der Waehler Bild, Bearbeiten,
    // Video und Animate muss damit startbereit sein.
    for (const id of [...ids(animatePickerModels()), ...ids(videoPickerModels()), ...ids(editCapableModels())]) {
      const m = STUDIO_MODELS[id]
      if (!m) continue
      const pflicht = studioSchema(id).required ?? []
      const gelesen = new Set(Object.values(m.inputs))
      for (const field of Object.keys(m.inputs)) {
        if (pflicht.includes(field)) expect(['source_path', 'image_paths'], `${id}.${field}`).toContain(m.inputs[field])
      }
      expect(gelesen.has('video_path'), id).toBe(false)
      expect(gelesen.has('last_image_path') && pflicht.some((f) => m.inputs[f] === 'last_image_path'), id).toBe(false)
    }
  })

  it('zeigt im Schema jedes neuen Modells keine Liste als Eingabefeld, die die Oberflaeche nicht fuellt', () => {
    for (const id of Object.keys(NEU)) {
      for (const [field, schema] of Object.entries(studioFields(id))) {
        if (schema.type === 'array') expect(studioSchema(id).required ?? [], `${id}.${field}`).not.toContain(field)
      }
    }
  })

  it('der Katalog nennt die neuen Modelle mit ops studio, nie im klassischen Waehler', () => {
    for (const id of Object.keys(NEU)) {
      expect(cloudModelById(id)?.ops, id).toEqual(['studio'])
      expect(cloudModelsFor(STUDIO_MODELS[id].kind).map((m) => m.id), id).not.toContain(id)
    }
  })
})

describe('Maske', () => {
  it('ein Editor per Anweisung braucht keine Maske, flux-dev braucht eine', () => {
    for (const id of ['qwen-image-2.1-edit', 'minimax-h3-edit', 'qwen-image-edit']) expect(editNeedsMask(id), id).toBe(false)
    expect(editNeedsMask('flux-dev')).toBe(true)
  })
})

describe('eine Wahl aus einem anderen Tab startet keinen Lauf ohne Bild', () => {
  it('Text zu Bild laesst ein Studio-Bildmodell stehen und biegt Editoren um', () => {
    expect(modelForOp('image', 'generate', 'qwen-image-2.1')).toBe('qwen-image-2.1')
    expect(modelForOp('image', 'generate', 'z-image')).toBe('z-image')
    expect(modelForOp('image', 'generate', 'chroma')).toBe('chroma')
    // Character-Studio: der LoRA-Endpunkt bleibt, was er ist.
    expect(modelForOp('image', 'generate', 'flux-schnell-lora')).toBe('flux-schnell-lora')
    for (const edit of ['qwen-image-2.1-edit', 'qwen-image-edit', 'minimax-h3-edit']) {
      expect(modelForOp('image', 'generate', edit), edit).toBe('z-image-turbo')
    }
  })
})
