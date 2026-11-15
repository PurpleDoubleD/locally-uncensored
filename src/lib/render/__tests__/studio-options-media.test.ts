// Aus dem Web uebernommen (the web app).
// Endpruefung 02.10.2026: was die Optionen eines Studio-Laufs tragen duerfen.
//
// 1. Kein Feld, das eine Datei oder Adresse tragen kann und nicht ueber `inputs`
//    laeuft, kommt durch studio_options. Sonst gaebe ein roher POST an /api/jobs
//    beliebige fremde Adressen an den Anbieter (an der eigenen Ablage, der
//    Groessengrenze und ffprobe vorbei, der Preis haengt dann an der fremden
//    Datei).
// 2. Eine freie Groesse als Text hat Grenzen.
// 3. Video-Edit rechnet halb auf die Eingabe und halb auf die Ausgabe.

import { describe, expect, it } from 'vitest'
import preisZeilen from './fixtures/studio-prices-2026-10-02.json'
import { STUDIO_MODELS, isMediaField, studioCredits, studioFields, studioOptions, studioSchema } from '../studio-contract'

const FREMD = 'https://evil.example/x.png'

const GEMELDET: Record<string, string[]> = {
  'minimax-h3-ref': ['reference_videos', 'reference_audios'],
  'wan-3.0-ref': ['reference_videos', 'reference_audios'],
  'minimax-h3-video-edit': ['reference_images', 'reference_audios'],
}

function wert(type: string | undefined) {
  return type === 'array' ? [FREMD] : FREMD
}

describe('studio_options laesst keine freien Datei- und Adressfelder durch', () => {
  it('die gemeldeten Felder werden abgewiesen und stehen nicht in den Feldern der Oberflaeche', () => {
    for (const [id, felder] of Object.entries(GEMELDET)) {
      const props = studioSchema(id).properties ?? {}
      for (const f of felder) {
        expect(props[f], `${id}.${f} fehlt im Schema`).toBeDefined()
        expect(props[f].disabled, `${id}.${f} nicht abgeschaltet`).toBe(true)
        expect(Object.keys(studioFields(id)), `${id}.${f}`).not.toContain(f)
        expect(() => studioOptions(id, 'x', { [f]: wert(props[f].type) }, false), `${id}.${f}`).toThrow(/Unsupported model option/)
      }
    }
  })

  it('fuer JEDES Studio-Modell: jedes Medien- oder Adressfeld ausserhalb von inputs wird abgewiesen', () => {
    let geprueft = 0
    for (const [id, m] of Object.entries(STUDIO_MODELS)) {
      const props = studioSchema(id).properties ?? {}
      const promptField = m.promptField ?? 'prompt'
      for (const [key, schema] of Object.entries(props)) {
        if (m.inputs[key] || key === promptField) continue
        if (!isMediaField(key, schema)) continue
        geprueft++
        expect(Object.keys(studioFields(id)), `${id}.${key} steht in den Feldern`).not.toContain(key)
        expect(() => studioOptions(id, 'x', { [key]: wert(schema.type) }, false), `${id}.${key}`).toThrow(/Unsupported model option/)
      }
    }
    // Positivkontrolle: die Regel trifft wirklich etwas.
    expect(geprueft).toBeGreaterThanOrEqual(6)
  })

  it('kein Feld aus inputs und kein Schalter oder Auswahlfeld wird versehentlich gesperrt', () => {
    for (const [id, m] of Object.entries(STUDIO_MODELS)) {
      const fields = studioFields(id)
      for (const [key, schema] of Object.entries(studioSchema(id).properties ?? {})) {
        if (schema.type === 'boolean' || schema.enum || schema.type === 'integer' || schema.type === 'number') {
          if (!schema.disabled && !m.inputs[key] && !['enable_base64_output', 'enable_sync_mode'].includes(key) && key !== (m.promptField ?? 'prompt')) {
            expect(Object.keys(fields), `${id}.${key}`).toContain(key)
          }
        }
      }
    }
    // Kennungen des Anbieters sind keine Dateien.
    expect(Object.keys(studioFields('mureka-song'))).toContain('reference_id')
  })

  it('ein roher Wert in einem Feld, das in inputs steht, geht ebenfalls nicht durch Optionen', () => {
    for (const [id, m] of Object.entries(STUDIO_MODELS)) {
      for (const field of Object.keys(m.inputs)) {
        expect(() => studioOptions(id, 'x', { [field]: FREMD }, false), `${id}.${field}`).toThrow()
      }
    }
  })
})

describe('freie Groesse als Text', () => {
  const frei = Object.entries(STUDIO_MODELS).filter(([id]) => {
    const p = studioSchema(id).properties?.size
    return p && !p.enum && !p.disabled && !(p as { 'x-hidden'?: boolean })['x-hidden']
  }).map(([id]) => id)

  it('betrifft die Modelle mit freier Groesse', () => {
    for (const id of ['z-image', 'jib-mix-qwen']) expect(frei).toContain(id)
  })

  it.each(['z-image', 'jib-mix-qwen'])('%s: Breite und Hoehe zwischen 256 und 4096', (id) => {
    expect(studioOptions(id, 'x', { size: '1024*1024' }, false).size).toBe('1024*1024')
    // z-image rendert hoechstens 1536 je Seite (maxSide, Web 08.11.2026): eine
    // groessere Angabe wird verkleinert, nicht abgewiesen.
    expect(studioOptions(id, 'x', { size: '4096*4096' }, false).size).toBe(id === 'z-image' ? '1536*1536' : '4096*4096')
    expect(studioOptions(id, 'x', { size: '256*256' }, false).size).toBe('256*256')
    for (const zu of ['4097*1024', '1024*4097', '99999*99999', '255*1024', '1024*100', '0*0', '1*1', '1024x1024', '1024*', '*1024', '-5*1024', '1e3*1024']) {
      expect(() => studioOptions(id, 'x', { size: zu }, false), `${id} ${zu}`).toThrow(/Size must be/)
    }
  })

  it('jedes Modell mit freier Groesse prueft sie', () => {
    for (const id of frei) {
      expect(() => studioOptions(id, 'x', { size: '99999*99999' }, false), id).toThrow(/Size must be/)
    }
  })
})

describe('Video-Edit: halber Satz auf die Eingabe, halber auf die Ausgabe', () => {
  const EIN = 10.026667 // gemessene Eingabe, wird auf 11 Sekunden aufgerundet
  const preise = preisZeilen as Array<{ model: string; options: Record<string, unknown>; usd: number; seconds?: number }>

  const credits = (id: string, o: Record<string, unknown>) => studioCredits(id, studioOptions(id, 'x', o, false), EIN)

  it('MiniMax H3 480p: ohne Dauer 110000 Credits, Dauer 3 gleich 70000, Dauer 15 gleich 130000', () => {
    expect(credits('minimax-h3-video-edit', { resolution: '480p' })).toBe(110000)
    expect(credits('minimax-h3-video-edit', { resolution: '480p', duration: 3 })).toBe(70000)
    expect(credits('minimax-h3-video-edit', { resolution: '480p', duration: 15 })).toBe(130000)
  })

  it('jede am Anbieter gemessene Zeile stimmt genau', () => {
    const zeilen = preise.filter((r) => /video-edit$/.test(r.model))
    expect(zeilen.length).toBeGreaterThanOrEqual(16)
    for (const r of zeilen) {
      const o = studioOptions(r.model, 'x', r.options, false)
      expect(studioCredits(r.model, o, r.seconds), `${r.model} ${JSON.stringify(r.options)}`).toBe(Math.round(r.usd * 100000))
    }
  })

  it('das Modell traegt den Modus inout und liest die Eingabe aus der Messung', () => {
    expect(STUDIO_MODELS['minimax-h3-video-edit'].price.mode).toBe('inout')
    expect(() => studioCredits('minimax-h3-video-edit', { resolution: '480p' })).toThrow()
    expect(() => studioCredits('minimax-h3-video-edit', { resolution: '480p' }, 16)).toThrow(/no longer than 15/)
  })
})
