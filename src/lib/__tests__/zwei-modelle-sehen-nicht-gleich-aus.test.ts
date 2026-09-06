/**
 * Zwei verschiedene Modelle duerfen in keiner Liste gleich aussehen.
 *
 * Gegenprobe G1, 04.09.2026, echter Windows-Build. Mit LM Studio als Provider
 * reicht die Anwendung dessen interne Kennungen unveraendert an zwei
 * Oberflaechen durch, je sechs Stueck. Der schwerere Teil davon ist kein
 * Schoenheitsfehler: das Aufklappmenue kuerzt am ENDE, also standen
 *
 *     qwen2.5-0.5b-instruct@...
 *     qwen2.5-0.5b-instruct...
 *
 * untereinander und sahen GLEICH aus. Das eine ist q4_k_m, das andere q8_0.
 * Genau das Zeichen, das die beiden unterscheidet, war das erste, das
 * weggeschnitten wurde.
 *
 * Run: npx vitest run src/lib/__tests__/zwei-modelle-sehen-nicht-gleich-aus.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shortModelLabel, splitForMiddleEllipsis } from '../model-label'
import { extractQuant } from '../lmstudio-match'

/** Wort fuer Wort die sechs Kennungen, die G1 auf der Box gesehen hat. */
const G1 = [
  'qwen/qwen3-4b',
  'qwen/qwen3-4b/qwen3-4b-q4_k_m.gguf',
  'qwen/qwen2.5-vl-7b',
  'qwen2.5-0.5b-instruct@q4_k_m',
  'qwen2.5-0.5b-instruct@q8_0',
  'mlabonne_gemma-3-4b-it-abliterated',
]

describe('was von einer fremden Kennung uebrig bleibt', () => {
  it('Pfadteile und Dateiendung fallen weg', () => {
    expect(shortModelLabel('qwen/qwen3-4b/qwen3-4b-q4_k_m.gguf')).toBe('qwen3-4b-q4_k_m')
    expect(shortModelLabel('qwen/qwen3-4b')).toBe('qwen3-4b')
    expect(shortModelLabel('qwen/qwen2.5-vl-7b')).toBe('qwen2.5-vl-7b')
  })

  it('aber kein Teil des Namens selbst', () => {
    // Der Kunde hat diese Datei unter diesem Namen geladen und muss sie unter
    // diesem Namen wiederfinden. `mlabonne_` ist Teil des Dateinamens.
    expect(shortModelLabel('mlabonne_gemma-3-4b-it-abliterated'))
      .toBe('mlabonne_gemma-3-4b-it-abliterated')
    expect(shortModelLabel('qwen2.5-0.5b-instruct@q8_0')).toBe('qwen2.5-0.5b-instruct@q8_0')
  })

  it('und ein gewoehnlicher Dateiname bleibt, wie er ist', () => {
    expect(shortModelLabel('Phi-4-mini-instruct-Q4_K_M')).toBe('Phi-4-mini-instruct-Q4_K_M')
  })
})

describe('der Quant bleibt stehen, wenn gekuerzt wird', () => {
  it('der Fund aus G1: die beiden trennen sich am Ende, und das Ende bleibt', () => {
    const a = splitForMiddleEllipsis('qwen2.5-0.5b-instruct@q4_k_m')
    const b = splitForMiddleEllipsis('qwen2.5-0.5b-instruct@q8_0')
    expect(a.head).toBe(b.head)
    expect(a.tail).toBe('@q4_k_m')
    expect(b.tail).toBe('@q8_0')
    expect(a.tail).not.toBe(b.tail)
  })

  it('das Ende ist genau der Teil, den auch der Vergleich als Quant liest', () => {
    for (const id of G1) {
      const { tail } = splitForMiddleEllipsis(id)
      const quant = extractQuant(id)
      if (quant === null) expect(tail).toBe('')
      else expect(tail.replace(/[^a-z0-9]/gi, '').toLowerCase()).toBe(quant)
    }
  })

  it('Kopf und Ende ergeben zusammen wieder den kurzen Namen', () => {
    for (const id of [...G1, 'Phi-4-mini-instruct-Q4_K_M', 'Hermes-3-Llama-3.2-3B.Q4_K_M']) {
      const { head, tail } = splitForMiddleEllipsis(id)
      expect(head + tail).toBe(shortModelLabel(id))
    }
  })

  // Negativkontrolle: genau das war der Fehler. Am Ende gekuerzt sind die
  // beiden nicht zu unterscheiden.
  it('am Ende gekuerzt saehen sie gleich aus', () => {
    const amEnde = (s: string) => s.slice(0, 21)
    expect(amEnde('qwen2.5-0.5b-instruct@q4_k_m'))
      .toBe(amEnde('qwen2.5-0.5b-instruct@q8_0'))
  })
})

describe('verdrahtet', () => {
  const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

  it('der Waehler kuerzt in der Mitte', () => {
    const src = lies('components/models/ModelSelector.tsx')
    expect(src).toContain('splitForMiddleEllipsis(modelDisplayName)')
    expect(src).toContain('<span className="truncate">{nameKopf}</span>')
    expect(src).toContain('{nameEnde && <span className="shrink-0">{nameEnde}</span>}')
  })

  it('die Models-Kachel auch, denn dort standen dieselben Kennungen', () => {
    const src = lies('components/models/ModelCard.tsx')
    expect(src).toContain('splitForMiddleEllipsis(displayModelName(model.name))')
    expect(src).toContain('<span className="truncate">{nameKopf}</span>')
  })

  it('und der Knopf im Eingabefeld traegt keinen Pfad mehr', () => {
    expect(lies('components/models/ModelSelector.tsx'))
      .toContain('shortModelLabel(displayModelName(gezeigtesModell)')
  })
})
