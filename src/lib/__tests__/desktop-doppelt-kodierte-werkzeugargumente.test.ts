/**
 * Die Wache fuer KF-32 — `repairToolCallArgs` im DESKTOP.
 *
 * ## Was kaputt war
 *
 * `src/lib/tool-call-repair.ts` hatte denselben Defekt, den der Mobile-Client
 * am 01.09.2026 mit `b133160b` losgeworden ist, nur an einer anderen Stelle
 * im Weg. `repairToolCallArgs` reichte eine Zeichenkette an `repairJson`
 * weiter. Fuer ein DOPPELT kodiertes Argument — `'"{\"path\":\"a.txt\"}"'`,
 * also eine JSON-Zeichenkette, die selbst JSON enthaelt — gelang das erste
 * `JSON.parse` in `tryRepair` und lieferte wieder eine Zeichenkette;
 * `asRepairedJson` gibt fuer alles, was weder Array noch Record ist, `null`
 * zurueck, die uebrigen Kandidaten scheiterten an den Escapes, die
 * Namens-Regex am Ende griff nicht — Rueckgabe `{}`.
 *
 * Gemessen am 01.09.2026 vor der Reparatur:
 *
 *     repairToolCallArgs(JSON.stringify('{"path":"a.txt"}'))  ->  {}
 *     repairJson(JSON.stringify('{"path":"a.txt"}'))          ->  null
 *
 * Eine Lage tiefer stand derselbe Fehler: `argumentObject` unter
 * `asRepairedJson` parste das `arguments`-Feld genau EINMAL, also fiel bei
 *
 *     {"name":"file_write","arguments":"\"{\\\"path\\\":\\\"a.txt\\\"}\""}
 *
 * das ganze Argumentobjekt weg und uebrig blieb `{ name: 'file_write' }`.
 *
 * ## Was jetzt gilt
 *
 * Dieselbe Schleife wie im Mobile-Client: reparieren, und solange dabei eine
 * Zeichenkette herauskommt, die naechste Lage abtragen — auf VIER
 * Dekodierschritte gedeckelt. Der Deckel ist derselbe wie drueben, damit die
 * beiden Seiten nicht bei fuenf Lagen auseinanderlaufen.
 *
 * ## Verhaeltnis zur Mobil-Wache
 *
 * `src/api/__tests__/mobile-doppelt-kodierte-werkzeugargumente.test.ts`
 * prueft dieselben Faelle gegen `mobile-client/agent-core.js`. Diese Datei
 * ist ihr Gegenstueck; die Faelle sind absichtlich dieselben, damit ein
 * Auseinanderdriften der beiden Implementierungen hier auffaellt. Was der
 * Desktop ZUSAETZLICH kann, steht unten in einem eigenen Block: `repairJson`
 * flickt auch einfache Quotes und Schleppkommata, und diese Faehigkeit gilt
 * jetzt auf jeder Lage, nicht nur auf der aeussersten.
 *
 * Lauf: npx vitest run src/lib/__tests__/desktop-doppelt-kodierte-werkzeugargumente.test.ts
 */
import { describe, it, expect } from 'vitest'
import { repairToolCallArgs, repairJson } from '../tool-call-repair'

/** Das Argumentobjekt, das am Ende jedes Mal herauskommen soll. */
const ZIEL = { path: 'a.txt', content: 'hallo' }
const EINFACH = JSON.stringify(ZIEL)
const DOPPELT = JSON.stringify(EINFACH)
const DREIFACH = JSON.stringify(DOPPELT)

describe('repairToolCallArgs (Desktop) — die Lagen werden wirklich abgetragen', () => {
  it('ein Objekt geht unveraendert durch (identisch, nicht nur gleich)', () => {
    const o = { path: 'a.txt' }
    expect(repairToolCallArgs(o)).toBe(o)
  })

  it('einfach kodiert: die Zeichenkette wird zum Objekt', () => {
    expect(repairToolCallArgs(EINFACH)).toEqual(ZIEL)
  })

  it('DOPPELT kodiert: der Fall, der bis zum 01.09.2026 {} ergab', () => {
    // Das war KF-32. Vor der Reparatur: {}.
    expect(repairToolCallArgs(DOPPELT)).toEqual(ZIEL)
  })

  it('dreifach kodiert — die Schleife haelt nicht nach einer Lage an', () => {
    expect(repairToolCallArgs(DREIFACH)).toEqual(ZIEL)
  })

  it('Leerraum um die aeussere Lage stoert nicht', () => {
    expect(repairToolCallArgs('  ' + DOPPELT + '\n')).toEqual(ZIEL)
  })

  it('vier Dekodierschritte gehen noch, fuenf nicht mehr — derselbe Deckel wie mobil', () => {
    const vier = JSON.stringify(DREIFACH)
    expect(repairToolCallArgs(vier)).toEqual(ZIEL)
    expect(repairToolCallArgs(JSON.stringify(vier))).toEqual({})
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
    // Kein Argumentobjekt, aber beide Seiten reichen es durch. Wer das
    // aendert, aendert Desktop UND mobile-client/agent-core.js.
    expect(repairToolCallArgs('[1,2]')).toEqual([1, 2])
    // Auch eingepackt: die Lage wird abgetragen, das Array bleibt ein Array.
    expect(repairToolCallArgs(JSON.stringify('[1,2]'))).toEqual([1, 2])
  })
})

describe('was der Desktop ueber den Mobile-Client hinaus kann, gilt auf JEDER Lage', () => {
  it('einfache Quotes werden auch in der zweiten Lage noch geflickt', () => {
    // `repairJson` kann das seit jeher — vor der Reparatur aber nur, wenn der
    // Schaden in der AEUSSERSTEN Lage sass.
    expect(repairToolCallArgs(JSON.stringify("{'path': 'a.txt'}"))).toEqual({ path: 'a.txt' })
  })

  it('ein Schleppkomma in der zweiten Lage ebenso', () => {
    expect(repairToolCallArgs(JSON.stringify('{"path": "a.txt",}'))).toEqual({ path: 'a.txt' })
  })
})

describe('und eine Lage tiefer: das `arguments`-Feld eines geparsten Aufrufs', () => {
  it('doppelt kodiertes `arguments` faellt nicht mehr weg', () => {
    // Vor der Reparatur kam hier { name: 'file_write' } heraus — `arguments`
    // war verschwunden, weil `argumentObject` genau einmal parste.
    const roh = JSON.stringify({ name: 'file_write', arguments: DOPPELT })
    expect(repairJson(roh)).toEqual({ name: 'file_write', arguments: ZIEL })
  })

  it('einfach kodiertes `arguments` verhaelt sich unveraendert', () => {
    const roh = JSON.stringify({ name: 'file_write', arguments: EINFACH })
    expect(repairJson(roh)).toEqual({ name: 'file_write', arguments: ZIEL })
  })

  it('und `parameters`, die andere Schreibweise, genauso', () => {
    const roh = JSON.stringify({ name: 'file_write', parameters: DOPPELT })
    expect(repairJson(roh)).toEqual({ name: 'file_write', parameters: ZIEL })
  })
})
