/**
 * Portiert aus dem Web (P1, Vertrag). Gekuerzt gegenueber dem Web-Original:
 * die Faelle zu CREATE_PRESETS/presetBaseCredits (create-presets.ts),
 * presetModels('duo') (preset-models.ts) und ownStudioPaths/probeDuration
 * (studio-prepare.ts, server, NICHT Teil des Desktops) haengen an Dateien,
 * die erst in P2 bzw. gar nicht in den Desktop kommen. Sie gehoeren, wo
 * sinnvoll, in die Testdatei ihres eigenen Pakets.
 *
 * Der Web-Fall "keeps API and worker definitions identical" vergleicht die
 * API-Kopie gegen die Worker-Kopie im selben Repo. Dafuer gibt es im Desktop
 * keine Entsprechung; stattdessen haelt der Fall unten die drei JSON-Dateien
 * gegen den Web-Worktree, wenn LU_WEB_REPO gesetzt ist, und ueberspringt
 * sonst sauber, denn der Web-Stand ist beweglich. Verglichen wird Zeichen
 * fuer Zeichen gegen das, was scripts/studio-snapshot.mjs aus den Dateien
 * des Webs macht: dieselben Dateien, nur dass ein Pfad nicht mehr den Namen
 * des Dienstes traegt und zwei Hilfetexte ihn nicht mehr nennen.
 *
 * Die Regeln selbst (studio-contract.ts) sind seit dem 08.10.2026 nicht mehr
 * byteidentisch: das Web haelt Pfade und Preise seither nur noch auf
 * dem Server und rechnet im Browser auf einem eigenen Katalog
 * (studio-catalog.ts). Verglichen wird deshalb, was zaehlt: fuer jedes Modell
 * dieselben Felder, dieselben Vorgaben und derselbe Preis. studio-roles.ts
 * bleibt byteidentisch bis auf die eine Importzeile, die dem folgt.
 *
 * Eine Abweichung ist gewollt (08.10.2026): in studio-models.json tragen die
 * offenen Eintraege im Feld `label` das Wort der Freigabe, und das Web fuehrt
 * dafuer sein neutrales Wort (siehe web-freigabe-wort.ts). Getauscht wird nur
 * in Zeilen dieses einen Feldes; jede andere Zeile bleibt byteidentisch.
 *
 * Run mit Drift-Pruefung: LU_WEB_REPO=/pfad/zum/web npx vitest run \
 *   src/lib/render/__tests__/studio-contract.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STUDIO_MODELS, STUDIO_MODELS_WITH_RETIRED, studioSchema, studioFields, studioOptions, studioCredits, studioBaseCredits, supportsProviderField } from '../studio-contract'
import { webCheckout, webModule } from '../../__tests__/web-checkout'
import { DESKTOP_WORT, alsDesktop, gezeigt, webNamen, webWort } from './web-freigabe-wort'
import { HOUSE, SNAPSHOT_FILES, checkSnapshot, neutralText, snapshotFromWeb } from '../../../../scripts/studio-snapshot.mjs'

const WEB = webCheckout('studio-contract', [
  'apps/web/lib/render/studio-models.json',
  'apps/web/lib/render/studio-catalog.ts',
  'apps/web/lib/render/studio-roles.ts',
])

/** Die Regeln des Webs, wie der Browser sie rechnet. */
interface WebRegeln {
  STUDIO_MODELS: Record<string, unknown>
  studioFields: (id: string) => Record<string, unknown>
  studioOptions: (id: string, prompt: string, raw: unknown, checkPrompt?: boolean) => Record<string, unknown>
  studioBaseCredits: (id: string) => number
  supportsProviderField: (id: string, field: string, op?: string, lora?: boolean) => boolean
}
const webRegeln = () => webModule<WebRegeln>(WEB!, 'apps/web/lib/render/studio-catalog.ts')

/** Ein Feldschema ohne seine Hilfetexte. Die sind auf den zwei Seiten nicht
 *  dieselben: das Web nimmt beim Bau seines Browser-Katalogs den Namen des
 *  Anbieters aus drei Beschreibungen. Typ, Grenzen, Auswahl und Vorgabe eines
 *  Feldes bleiben verglichen. */
const HILFETEXTE = new Set(['description', 'x-hint'])
function ohneBeschreibung(wert: unknown): unknown {
  if (Array.isArray(wert)) return wert.map(ohneBeschreibung)
  if (!wert || typeof wert !== 'object') return wert
  return Object.fromEntries(
    Object.entries(wert).filter(([k]) => !HILFETEXTE.has(k)).map(([k, v]) => [k, ohneBeschreibung(v)]),
  )
}

/** Ergebnis oder Fehlertext: beide Seiten muessen auch gleich scheitern. */
function oder<T>(f: () => T): T | string {
  try { return f() } catch (e) { return `throws: ${(e as Error).message}` }
}

describe('Cloud studio contracts', () => {
  describe.skipIf(!WEB)('haelt die Vertragsdaten byteidentisch gegen den Web-Worktree', () => {
    it.each(SNAPSHOT_FILES)('%s', (f) => {
      const desktop = readFileSync(resolve('src/lib/render', f), 'utf8')
      const roh = readFileSync(resolve(WEB!, 'apps/web/lib/render', f), 'utf8')
      const web = neutralText(f, roh)
      // Positivkontrolle: jede der drei Dateien traegt im Web Pfade, die der
      // Abgleich umschreibt. Ohne sie waere der Schritt leer.
      expect(web).not.toBe(roh)
      // Und was das Skript als Ganzes schreibt, ist genau die Datei.
      expect(snapshotFromWeb(WEB!)[f]).toBe(desktop)
      if (f !== 'studio-models.json') return expect(desktop).toBe(web)
      const wort = webWort(WEB!)
      expect(wort).not.toBe(DESKTOP_WORT)
      const zeilen = web.split('\n')
      const namen = zeilen.filter((z) => /^\s*"label": /.test(z) && z.includes(wort))
      // Positivkontrolle: ohne Traeger waere der Tausch unten leer.
      expect(namen.length).toBeGreaterThan(0)
      // Das Wort des Desktops steht im Web nirgends, auch nicht in einem Namen.
      expect(zeilen.filter((z) => /^\s*"label": /.test(z) && z.includes(DESKTOP_WORT))).toEqual([])
      const getauscht = zeilen.map((z) => (/^\s*"label": /.test(z) ? alsDesktop(z, wort) : z)).join('\n')
      expect(desktop).toBe(getauscht)
      // Und die Traeger sind genau die offenen Eintraege mit dem Wort des Desktops.
      const traeger = Object.entries(STUDIO_MODELS).filter(([, m]) => m.label.includes(DESKTOP_WORT))
      expect(traeger.length).toBe(namen.length)
      for (const [id, m] of traeger) expect(m.adult, id).toBe(true)
    })
  })

  describe.skipIf(!WEB)('rechnet wie das Web', () => {
    it('studio-roles.ts ist die Datei des Webs, bis auf die Zeile, die die Regeln holt', () => {
      const desktop = readFileSync(resolve('src/lib/render/studio-roles.ts'), 'utf8')
      const web = readFileSync(resolve(WEB!, 'apps/web/lib/render/studio-roles.ts'), 'utf8')
      expect(web).toContain("from './studio-catalog'")
      expect(desktop).toBe(web.replace("from './studio-catalog'", "from './studio-contract'"))
    })

    it('jedes Modell hat dieselben Felder, dieselben Vorgaben und denselben Preis', async () => {
      const web = await webRegeln()
      const ids = Object.keys(STUDIO_MODELS)
      expect(Object.keys(web.STUDIO_MODELS)).toEqual(ids)
      // Positivkontrolle: ein leerer Vergleich waere auch gleich.
      expect(ids.length).toBeGreaterThan(40)
      let bepreist = 0
      for (const id of ids) {
        expect(ohneBeschreibung(web.studioFields(id)), id).toEqual(ohneBeschreibung(studioFields(id)))
        expect(oder(() => web.studioOptions(id, 'a prompt', undefined, false)), id)
          .toEqual(oder(() => studioOptions(id, 'a prompt', undefined, false)))
        const preis = oder(() => studioBaseCredits(id))
        expect(oder(() => web.studioBaseCredits(id)), id).toEqual(preis)
        if (typeof preis === 'number') bepreist++
      }
      expect(bepreist).toBeGreaterThan(40)
    })

    it('und kennt dieselben Felder am Endpunkt, auch bei den klassischen Modellen', async () => {
      const web = await webRegeln()
      const proben: [string, string, string][] = [
        ['wan-2.6-spicy', 'negative_prompt', 'animate'],
        ['wan-2.7-spicy', 'negative_prompt', 'animate'],
        ['wan-2.2-spicy', 'negative_prompt', 'animate'],
        ['open-video', 'negative_prompt', 'animate'],
        ['open-video', 'duration', 'generate'],
      ]
      for (const [id, feld, op] of proben) {
        expect(web.supportsProviderField(id, feld, op), `${id} ${feld}`).toBe(supportsProviderField(id, feld, op))
      }
    })
  })

  describe.skipIf(!WEB)('haelt die Studio-Namen gegen das Zusatzfeld des Webs', () => {
    it('Name der App gleich native_label des Webs, Name des Webs gleich dem der App mit getauschtem Wort', async () => {
      // Die Studio-Eintraege reisen als Zeilen des Katalogs (ops ['studio']),
      // und der Server schickt fuer die offenen den Namen der App mit. Die
      // mitgelieferte Registrierung der App muss genau so heissen.
      const namen = await webNamen(WEB!)
      expect(namen.DESKTOP_MARK_LABEL).toBe(DESKTOP_WORT)
      const web = JSON.parse(readFileSync(resolve(WEB!, 'apps/web/lib/render/studio-models.json'), 'utf8')) as Record<string, { label: string }>
      // Die Datei fuehrt auch die zurueckgezogenen Modelle (retired-models.ts).
      expect(Object.keys(web)).toEqual(Object.keys(STUDIO_MODELS_WITH_RETIRED))
      let mitFeld = 0
      for (const [id, w] of Object.entries(web)) {
        expect(STUDIO_MODELS_WITH_RETIRED[id].label, id).toBe(gezeigt(namen, w.label))
        expect(w.label, id).toBe(namen.webName(STUDIO_MODELS_WITH_RETIRED[id].label))
        if (namen.desktopName(w.label) !== null) mitFeld++
      }
      // Fuenf seit dem 08.10.2026, dazu die zwei MiniMax H3 Singularity
      // (Web 3b5d5980, 3.1.0).
      expect(mitFeld).toBe(7)
    })
  })

  describe('die Vertragsdaten nennen den Dienst nicht, auf dem ein Modell laeuft', () => {
    const texte = Object.fromEntries(SNAPSHOT_FILES.map((f) => [f, readFileSync(resolve('src/lib/render', f), 'utf8')]))

    it('jede Datei ist schon, was der Abgleich aus ihr machen wuerde', () => {
      for (const f of SNAPSHOT_FILES) expect(neutralText(f, texte[f]), f).toBe(texte[f])
    })

    it('jedes Modell und jede Variante findet ihr Schema, und keine Zeile traegt den Namen', () => {
      expect(() => checkSnapshot(texte)).not.toThrow()
      // Positivkontrolle: die neutralen Schluessel gibt es wirklich.
      expect(Object.values(STUDIO_MODELS).filter((m) => m.endpoint.startsWith(`${HOUSE}/`)).length).toBeGreaterThan(30)
    })

    it('der Abgleich schreibt einen Pfad um und laesst jeden anderen Wert stehen', () => {
      // Aus Teilen gebaut, damit diese Datei den Namen nicht traegt.
      const dienst = ['wave', 'speed-ai'].join('')
      expect(neutralText('studio-models.json', `    "endpoint": "${dienst}/flux-dev",`)).toBe(`    "endpoint": "${HOUSE}/flux-dev",`)
      expect(neutralText('provider-schemas.json', `  "${dienst}/flux-dev": {`)).toBe(`  "${HOUSE}/flux-dev": {`)
      expect(neutralText('provider-endpoints.json', `    "t2Lora": "${dienst}/wan-2.2/t2v-720p-lora"`)).toBe(`    "t2Lora": "${HOUSE}/wan-2.2/t2v-720p-lora"`)
      // Der Pfad eines anderen Hauses bleibt, wie er ist.
      const fremd = '    "endpoint": "alibaba/wan-3.0/image-to-video",'
      expect(neutralText('studio-models.json', fremd)).toBe(fremd)
      // Eine Vorgabe ist kein Pfad des Katalogs: sie ginge an den Server und
      // bleibt deshalb unberuehrt. checkSnapshot meldet sie stattdessen.
      const vorgabe = `        "default": "${dienst}/a-lora",`
      for (const f of SNAPSHOT_FILES) expect(neutralText(f, vorgabe), f).toBe(vorgabe)
      expect(() => checkSnapshot({ ...texte, 'provider-schemas.json': texte['provider-schemas.json'].replace('"default": "mp3"', `"default": "${dienst}/x"`) })).toThrow(/still name the service/)
    })
  })

  it.each(Object.keys(STUDIO_MODELS))('has a schema for %s', (id) => expect(studioSchema(id).properties).toBeTruthy())

  it('reads negative prompt support from endpoint schemas', () => {
    for (const id of ['wan-2.6-spicy', 'wan-2.7-spicy']) expect(supportsProviderField(id, 'negative_prompt', 'animate')).toBe(true)
    for (const id of ['wan-2.2-spicy', 'open-video']) expect(supportsProviderField(id, 'negative_prompt', 'animate')).toBe(false)
  })

  it('prices OpenVideo seconds and resolution', () => {
    expect(studioCredits('open-video', studioOptions('open-video', 'test', { duration: 20, resolution: '1080p' }))).toBe(120000)
    expect(studioCredits('open-video-lora', studioOptions('open-video-lora', 'test', { duration: 10, resolution: '720p' }))).toBe(50000)
  })

  it('rejects arbitrary URLs in curated LoRAs', () => {
    expect(() => studioOptions('open-video-lora', 'test', { loras: [{ path: 'https://evil.test/model' }] })).toThrow()
    expect(studioOptions('open-video-lora', 'test', { loras: [{ path: 'better_motion', scale: 1 }] }).loras).toBeTruthy()
  })

  it('validates options', () => {
    expect(studioOptions('open-video', 'test', {}).duration).toBe(5)
    for (const options of [{ duration: 100 }, { negative_prompt: 'x' }, { seed: NaN }]) expect(() => studioOptions('open-video', 'test', options)).toThrow()
    expect(studioOptions('scail-2', 'test', { mode: 'replace' }).mode).toBe('replace')
  })

  it('rounds measured duration and enforces input caps', () => {
    const o = studioOptions('infinitetalk', '', {})
    expect(studioCredits('infinitetalk', o, 1)).toBe(9000)
    expect(studioCredits('infinitetalk', o, 5.2)).toBe(18000)
    expect(() => studioCredits('infinitetalk', o)).toThrow()
    expect(() => studioCredits('infinitetalk', o, 601)).toThrow()
  })

  it('prices extra images and 2k', () =>
    expect(studioCredits('minimax-h3-edit', studioOptions('minimax-h3-edit', 'test', { resolution: '2k' }), undefined, 3)).toBe(10000))

  it('requires a valid Ditto style', () => {
    expect(() => studioOptions('wan-ditto', 'something', {})).toThrow()
    expect(studioOptions('wan-ditto', 'Watercolor', {}).resolution).toBe('480p')
  })
})

it('prices TTS per character above its minimum and preserves full WAN duration support', () => {
  expect(studioCredits('preset-qwen3-tts', studioOptions('preset-qwen3-tts', 'hello', {}), undefined, 1, 101)).toBe(505)
  expect(studioCredits('preset-qwen3-tts', studioOptions('preset-qwen3-tts', 'hello', {}), undefined, 1, 4000)).toBe(20000)
  for (const id of ['wan-3.0', 'wan-3.0-spicy']) for (const duration of [2, 3, 30]) expect(studioOptions(id, 'scene', { duration }).duration).toBe(duration)
  for (const duration of [1, 31]) expect(() => studioOptions('wan-3.0', 'scene', { duration })).toThrow()
})

import livePrices from './fixtures/studio-prices-2026-09-19.json'
it.each(livePrices)('matches live provider price for $model with $options', (row) => {
  const options = studioOptions(row.model, '', row.options, false)
  expect(studioCredits(row.model, options, row.seconds, 1, row.promptLength)).toBe(Math.round(row.usd * 100000))
})
