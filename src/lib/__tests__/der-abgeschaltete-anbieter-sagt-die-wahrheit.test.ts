/**
 * Nebenbefund der Nachpruefung G3, 04.09.2026: unter der abgeschalteten LU
 * Engine stand "its models are not offered in the chat model picker", und der
 * Waehler bot weiter alle fuenf an.
 *
 * Beides war fuer sich richtig. Die Zeilen der eigenen Engine kommen aus dem
 * Ordner mit den GGUF-Dateien, nicht aus `/v1/models`, also faellt der Satz
 * ueber `getEnabledProviders` gar nicht auf sie an. Und stehen bleiben sollen
 * sie, denn ein Klick holt den Steckplatz zurueck. Falsch war nur der Satz.
 *
 * Lauf: npx vitest run src/lib/__tests__/der-abgeschaltete-anbieter-sagt-die-wahrheit.test.ts
 */
import { describe, it, expect } from 'vitest'
import { disabledSlotNote } from '../disabled-slot-note'

describe('disabledSlotNote', () => {
  it('behauptet bei der eigenen Engine nicht, ihre Modelle seien weg', () => {
    const satz = disabledSlotNote(true)
    expect(satz).not.toContain('not offered')
    expect(satz).toContain('stay in the chat model picker')
    // Und sagt, was ein Klick darauf dann tut.
    expect(satz).toContain('switches it back on')
    expect(satz).toContain('Enable')
  })

  it('bleibt bei einem fremden Anbieter beim alten, richtigen Satz', () => {
    const satz = disabledSlotNote(false)
    expect(satz).toContain('not offered in the chat model picker')
    expect(satz).toContain('Press Enable to use it again')
  })

  it('spricht Englisch und ohne Gedankenstrich', () => {
    for (const satz of [disabledSlotNote(true), disabledSlotNote(false)]) {
      expect(satz).not.toMatch(/[–—]/)
      expect(satz).toMatch(/^[\x20-\x7E]+$/)
    }
  })

  it('haengt wirklich in der Oberflaeche und ist nicht nur eine Funktion', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const quelle = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/settings/ProviderConfig.tsx'),
      'utf8',
    )
    expect(quelle).toContain('disabledSlotNote(config?.managed === true)')
    // Der alte, fuer die eigene Engine falsche Satz steht nirgends mehr fest.
    expect(quelle).not.toContain('so its models are not offered')
  })
})
