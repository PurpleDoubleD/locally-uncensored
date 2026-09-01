/**
 * Die Wache fuer KF-3 (1) — `repairToolCallArgs` im Mobile-Client.
 *
 * ## Was kaputt war
 *
 * `mobile-client/agent-core.js` hatte unter dem ersten `JSON.parse` einen
 * Zweig mit der Aufschrift „Some models double-encode the args". Erreichbar
 * war er nie. Ein doppelt kodiertes Argument — `'"{\"path\":\"a.txt\"}"'` —
 * IST gueltiges JSON, naemlich eine JSON-Zeichenkette. Das erste `JSON.parse`
 * gelang also, `typeof parsed` war `'string'`, und die Funktion gab `{}`
 * zurueck, bevor sie den Zweig auch nur sah. Genau der Fehler, den der
 * Kommentar darueber zu beheben behauptete: der Rust-Endpunkt
 * `/remote-api/agent-tool` bekam ein leeres Argumentobjekt und `file_write`
 * antwortete „needs argument".
 *
 * Bis zum 01.09.2026 war dieses Verhalten sogar FESTGENAGELT
 * (`mobile-codex-parity.test.ts`, „does NOT unwrap a double-encoded string"),
 * weil T-75 den Client byteweise unveraendert aus einem Rust-String heben
 * musste. Der Pin ist mit dieser Reparatur nachgezogen.
 *
 * ## Was diese Datei prueft
 *
 * Nicht die Bytes der Funktion, sondern ihr Verhalten an echten Eingaben:
 * einfach kodiert, doppelt kodiert, dreifach kodiert, mit Leerraum
 * drumherum, kaputt, leer, gar keine Zeichenkette — und dieselben Faelle
 * einmal auf dem Weg, auf dem der Client sie wirklich bekommt (der gezaeunte
 * ```json-Block, den kleine Modelle statt `tool_calls` schicken).
 *
 * ## Gemessener Unterschied zum Desktop (kein Fehler DIESER Datei)
 *
 * `src/lib/tool-call-repair.ts` hat denselben Defekt und behaelt ihn: gemessen
 * am 01.09.2026 gibt `repairToolCallArgs(JSON.stringify('{"path":"a.txt"}'))`
 * dort `{}` zurueck, weil `repairJson` eine geparste Skalar-Zeichenkette ueber
 * `asRepairedJson` zu `null` macht und nie ein zweites Mal parst. Mobile ist
 * damit an dieser Stelle jetzt BESSER als Desktop. Das steht hier als
 * Messwert und nicht als Zusicherung — ein `expect(desktop(...)).toEqual({})`
 * waere wieder ein Pin auf einen Fehler.
 *
 * Lauf: npx vitest run src/api/__tests__/mobile-doppelt-kodierte-werkzeugargumente.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  extractToolCallsFromContent,
  repairToolCallArgs,
} from '../../../mobile-client/agent-core.js'

/** Das Argumentobjekt, das am Ende jedes Mal herauskommen soll. */
const ZIEL = { path: 'a.txt', content: 'hallo' }
const EINFACH = JSON.stringify(ZIEL)
const DOPPELT = JSON.stringify(EINFACH)
const DREIFACH = JSON.stringify(DOPPELT)

describe('repairToolCallArgs — die Lagen werden wirklich abgetragen', () => {
  it('ein Objekt geht unveraendert durch (identisch, nicht nur gleich)', () => {
    const o = { path: 'a.txt' }
    expect(repairToolCallArgs(o)).toBe(o)
  })

  it('einfach kodiert: die Zeichenkette wird zum Objekt', () => {
    expect(repairToolCallArgs(EINFACH)).toEqual(ZIEL)
  })

  it('DOPPELT kodiert: der Fall, den der tote Zweig behauptete', () => {
    // Vor der Reparatur: {}. Das war der Befund.
    expect(repairToolCallArgs(DOPPELT)).toEqual(ZIEL)
  })

  it('dreifach kodiert — die Schleife haelt nicht nach einer Lage an', () => {
    expect(repairToolCallArgs(DREIFACH)).toEqual(ZIEL)
  })

  it('Leerraum um die aeussere Lage stoert nicht', () => {
    expect(repairToolCallArgs('  ' + DOPPELT + '\n')).toEqual(ZIEL)
  })

  it('die Schleife ist gedeckelt: mehr Lagen als vier ergeben {}, nicht eine Endlosschleife', () => {
    let tief: string = EINFACH
    for (let i = 0; i < 6; i++) tief = JSON.stringify(tief)
    expect(repairToolCallArgs(tief)).toEqual({})
  })

  it('kaputt bleibt kaputt — {} statt eines Wurfs', () => {
    expect(repairToolCallArgs('not json')).toEqual({})
    expect(repairToolCallArgs('{"path":')).toEqual({})
    expect(repairToolCallArgs('"nur eine Zeichenkette"')).toEqual({})
    expect(repairToolCallArgs('""')).toEqual({})
  })

  it('leer, null, undefined und Nicht-Zeichenketten ergeben {}', () => {
    expect(repairToolCallArgs('')).toEqual({})
    expect(repairToolCallArgs('   ')).toEqual({})
    expect(repairToolCallArgs(null)).toEqual({})
    expect(repairToolCallArgs(undefined)).toEqual({})
    expect(repairToolCallArgs(7)).toEqual({})
    expect(repairToolCallArgs(true)).toEqual({})
    expect(repairToolCallArgs('null')).toEqual({})
  })

  it('ein JSON-Array bleibt ein Array — geerbtes Verhalten, hier nur festgehalten', () => {
    // Kein Argumentobjekt, aber der Desktop reicht es genauso durch
    // (src/lib/tool-call-repair.ts, `Array.isArray`-Zweig). Wer das aendert,
    // aendert beide Seiten.
    expect(repairToolCallArgs('[1,2]')).toEqual([1, 2])
  })
})

describe('und auf dem Weg, auf dem der Client die Argumente wirklich bekommt', () => {
  const bekannt = ['file_write', 'shell_execute']

  it('gezaeunter Aufruf mit doppelt kodierten Argumenten kommt entpackt an', () => {
    // Genau das, was qwen2.5-coder in `content` legt statt in `tool_calls`:
    // der Aufruf als ```json-Block, und `arguments` darin noch einmal als
    // Zeichenkette kodiert.
    const content =
      'ich schreibe die Datei\n```json\n' +
      JSON.stringify({ name: 'file_write', arguments: EINFACH }) +
      '\n```\nfertig'
    const { calls } = extractToolCallsFromContent(content, bekannt)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('file_write')
    expect(calls[0].function.arguments).toEqual(ZIEL)
  })

  it('und ein kaputtes `arguments` liefert {} statt den Aufruf zu verlieren', () => {
    const content =
      '```json\n' +
      JSON.stringify({ name: 'shell_execute', arguments: '{command:' }) +
      '\n```'
    const { calls } = extractToolCallsFromContent(content, bekannt)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.arguments).toEqual({})
  })
})
