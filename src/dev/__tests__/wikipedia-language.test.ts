/**
 * Siehe den Kopf von `wikipedia-language.ts` fuer die Messung, aus der diese
 * Regel kommt (en.wikipedia 0 Treffer, de.wikipedia 31, DuckDuckGo HTTP 202).
 *
 * Lauf: npx vitest run src/dev/__tests__/wikipedia-language.test.ts
 */
import { describe, it, expect } from 'vitest'
import { sprachSignalDeutsch, wikiSprachen, wikiSuchUrl, wikiVersuche } from '../wikipedia-language'

describe('welche Wikipedia zuerst gefragt wird', () => {
  it('die Frage der Persona geht zuerst an die deutsche', () => {
    // Drei Substantive, kein Artikel, kein Umlaut — der schwerste Fall.
    expect(wikiSprachen('Transparenzgesetz Hamburg Antragsfristen')).toEqual(['de', 'en'])
  })

  it('Umlaute und ss zaehlen sofort', () => {
    expect(sprachSignalDeutsch('Gebührenordnung')).toBe(true)
    expect(sprachSignalDeutsch('Strassenverkehr')).toBe(false) // ohne Signal: kein Artikel, keine Endung
    expect(sprachSignalDeutsch('Straßenverkehr')).toBe(true)
  })

  it('englische Fragen bleiben bei der englischen', () => {
    for (const q of [
      'Hamburg transparency law deadlines',
      'who is the president of the Bundestag',
      'best rust web framework 2026',
    ]) {
      expect(wikiSprachen(q), q).toEqual(['en', 'de'])
    }
  })

  it('beide Sprachen bleiben IMMER in der Liste', () => {
    // Eine Vermutung, die die andere Sprache ausschliesst, wiederholt genau
    // den Fehler, den sie beheben soll.
    for (const q of ['Transparenzgesetz', 'transparency law', '', '12345']) {
      expect(wikiSprachen(q).sort()).toEqual(['de', 'en'])
    }
  })

  it('die Adresse traegt die Sprache und die Anfrage kodiert', () => {
    const url = wikiSuchUrl('de', 'Gebühren & Fristen', 5)
    expect(url).toContain('https://de.wikipedia.org/')
    expect(url).toContain(encodeURIComponent('Gebühren & Fristen'))
    expect(url).toContain('srlimit=5')
  })
})

describe('welche Anfragen die Wikipedia-Stufe versucht', () => {
  it('kuerzt von hinten, wenn die volle Anfrage nichts findet', () => {
    // Gemessen: „Transparenzgesetz Hamburg Antragsfristen" = 0 Treffer auf
    // de.wikipedia, „Transparenzgesetz Hamburg" = 31. Wikipedia
    // UND-verknuepft die Begriffe.
    const v = wikiVersuche('Transparenzgesetz Hamburg Antragsfristen')
    expect(v[0]).toEqual({ sprache: 'de', query: 'Transparenzgesetz Hamburg Antragsfristen' })
    expect(v[1]).toEqual({ sprache: 'de', query: 'Transparenzgesetz Hamburg' })
  })

  it('geht nie unter zwei Begriffe', () => {
    // Ein einzelnes Wort findet alles und damit nichts.
    const v = wikiVersuche('a b c d e')
    expect(v.every((x) => x.query.split(' ').length >= 2)).toBe(true)
  })

  it('probiert danach die andere Sprache', () => {
    const v = wikiVersuche('Transparenzgesetz Hamburg', 4)
    expect(v.map((x) => x.sprache)).toEqual(['de', 'en'])
  })

  it('ist gedeckelt — die letzte Stufe darf nicht zur Suchmaschine werden', () => {
    expect(wikiVersuche('a b c d e f g h', 4)).toHaveLength(4)
  })

  it('leere Anfrage ergibt keinen Versuch', () => {
    expect(wikiVersuche('   ')).toEqual([])
  })

  it('ein einzelnes Wort wird genau einmal je Sprache versucht', () => {
    expect(wikiVersuche('Transparenzgesetz')).toEqual([
      { sprache: 'de', query: 'Transparenzgesetz' },
      { sprache: 'en', query: 'Transparenzgesetz' },
    ])
  })
})
