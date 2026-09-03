import { describe, it, expect } from 'vitest'
import { detectChatToolCapability } from '../chat-tool-intent'

/**
 * Waechter fuer die deutsche Seite der Absichtserkennung (Persona-Lauf
 * 03.09.2026). Drei getrennte Ursachen, die alle im selben Modul sitzen:
 *
 * 1. "mal" ist im Deutschen fast immer die Partikel, nicht die Befehlsform von
 *    malen. Solange das Muster die Endung freistellt, kapert jeder beilaeufige
 *    Satz die Bildgenerierung. Ein Fehlalarm ist teuer, der Zug laeuft dann
 *    durch den Werkzeug-Ausfuehrer.
 * 2. Eine Wortgrenze vor einem Umlaut greift nie, weil Umlaute in JavaScript
 *    keine Wortzeichen sind. Jedes Muster, das mit \b vor "oe" in der
 *    Umlautschreibung steht, ist toter Buchstabe.
 * 3. Die Substantivliste kannte Seite und Artikel, aber kein einziges Wort fuer
 *    das Internet selbst. Genau so tippen Kunden aber.
 */
describe('deutsche Alltagssaetze treffen die richtigen Werkzeuge', () => {
  describe('die Partikel "mal" ist keine Malaufforderung', () => {
    for (const satz of [
      'erklaer mir mal wie das geht',
      'sag mal, was ist ein Transformer?',
      'kannst du mir mal helfen',
      'warte mal kurz',
      'guck mal ob das stimmt',
      'ueberleg mal, was waere wenn',
    ]) {
      it(`kein Werkzeug: "${satz}"`, () =>
        expect(detectChatToolCapability(satz)).toBeNull())
    }

    it('die echte Befehlsform am Satzanfang zaehlt weiter', () => {
      expect(detectChatToolCapability('mal eine Blume')).toBe('image')
    })

    it('mit Substantiv zaehlt sie auch mitten im Satz', () => {
      expect(detectChatToolCapability('mal mir ein Bild von einem Hund')).toBe('image')
    })
  })

  describe('Umlaute treffen in beiden Schreibweisen', () => {
    for (const satz of [
      'oeffne die Seite example.com',
      'öffne die Seite example.com',
      'Hol bitte die Seite example.com',
      'ruf die Webseite example.com auf',
      'schau dir den Artikel auf example.com an',
    ]) {
      it(`web: "${satz}"`, () =>
        expect(detectChatToolCapability(satz)).toBe('web'))
    }
  })

  describe('die deutschen Woerter fuer das Internet zaehlen als Ziel', () => {
    for (const satz of [
      'schau im Netz nach',
      'hol mir das aus dem Internet',
      'schau online nach',
      'kannst du das online nachschauen',
      'sieh im Web nach',
      'schau bitte im Internet nach dem Preis',
    ]) {
      it(`web: "${satz}"`, () =>
        expect(detectChatToolCapability(satz)).toBe('web'))
    }
  })

  describe('Gegenprobe: normales Gespraech bleibt unberuehrt', () => {
    for (const satz of [
      'wie geht es dir heute',
      'was ist ein Transformer',
      'danke, das hat geholfen',
      'ich mag das Bild das du beschrieben hast',
      'erklaer mir den Unterschied zwischen Netz und Graph',
    ]) {
      it(`kein Werkzeug: "${satz}"`, () =>
        expect(detectChatToolCapability(satz)).toBeNull())
    }
  })
})
