/**
 * `openai::` ist unser Steckplatzname. Kein Kunde hat ihn je gewaehlt, und
 * viele, die die LU Engine benutzen, haben mit OpenAI nichts zu tun.
 *
 * Die Zusage stand schon einmal als erfuellt in den Papieren. Die Nachpruefung
 * G3 hat am 04.09.2026 am echten Build NEUNZEHN Stellen gezaehlt, neun davon
 * als offener Text auf der Benchmark-Seite. Beim Nacharbeiten kamen drei
 * weitere Oberflaechen dazu, die der Tester gar nicht offen hatte: die beiden
 * Auswahlfelder im Compare-Reiter und die Modell-Liste des Gruppenchats.
 *
 * Ein Waechter statt einer weiteren Runde Suchen. Er liest den Quelltext, weil
 * genau das der Unterschied zwischen "an dieser Stelle gefixt" und "kommt
 * nicht wieder" ist.
 *
 * Lauf: npx vitest run src/components/__tests__/der-steckplatzname-steht-nirgends.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const WURZEL = resolve(__dirname, '..')

function alleDateien(ordner: string): string[] {
  const raus: string[] = []
  for (const eintrag of readdirSync(ordner)) {
    const voll = join(ordner, eintrag)
    if (statSync(voll).isDirectory()) {
      if (eintrag === '__tests__') continue
      raus.push(...alleDateien(voll))
    } else if (eintrag.endsWith('.tsx')) {
      raus.push(voll)
    }
  }
  return raus
}

/**
 * Die Stellen, an denen ein Chat-Modellname in die Oberflaeche geschrieben
 * wird, ohne durch `displayModelName` zu gehen.
 *
 * Bewusst eng gefasst: gesucht wird die Ausgabe eines nackten Namensfeldes als
 * JSX-Text oder als title, nicht jede Erwaehnung. Ein Fund ist entweder ein
 * echter Verstoss oder eine Liste, die gar keine Chat-Modelle fuehrt, und dann
 * gehoert die Datei in die Ausnahmeliste darunter, mit Begruendung.
 */
const MUSTER = [
  />\{(?:model|entry|m|sel)\.(?:name|model)\}</,
  /title=\{(?:model|entry|m|sel)\.(?:name|model)\}/,
  /className="[^"]*">\{(?:model|entry|m|sel)\.(?:name|model)\}</,
]

/**
 * Listen, die keine Chat-Modelle fuehren und deshalb keinen Steckplatz-Namen
 * tragen koennen. Jede Zeile ist eine Behauptung, die jemand widerlegen darf.
 */
const OHNE_STECKPLATZ = new Set([
  // MLX-Bild- und Videomodelle, lokale Ordnernamen ohne Anbieter davor.
  'settings/MlxMediaSettings.tsx',
  // Der Katalog: CivitAI- und HuggingFace-Eintraege, noch nichts Installiertes.
  'models/DiscoverModels.tsx',
])

describe('kein Steckplatz-Praefix in der Oberflaeche', () => {
  const dateien = alleDateien(WURZEL)

  it('findet ueberhaupt Dateien, sonst prueft dieser Test nichts', () => {
    expect(dateien.length).toBeGreaterThan(30)
  })

  it('schreibt nirgends einen nackten Modellnamen in die Oberflaeche', () => {
    const treffer: string[] = []
    for (const datei of dateien) {
      const kurz = datei.slice(WURZEL.length + 1)
      if (OHNE_STECKPLATZ.has(kurz)) continue
      const quelle = readFileSync(datei, 'utf8')
      for (const zeile of quelle.split('\n')) {
        if (MUSTER.some((m) => m.test(zeile))) treffer.push(`${kurz}: ${zeile.trim()}`)
      }
    }
    expect(treffer).toEqual([])
  })

  /**
   * Der zweite Waechter war einmal "nirgends steht die Zeichenkette openai::"
   * und ist wieder raus: er traf `m.startsWith('openai::')` in GroupCostHint,
   * also die Stelle, die den Steckplatz ERKENNT, und einen Ausdruck in
   * ModelSelector, der ihn WEGSCHNEIDET. Beides ist genau das Richtige. Eine
   * Regel, die die Loesung fuer den Fehler haelt, ist keine Regel. Was zaehlt,
   * steht oben: kein nackter Modellname geht an der Uebersetzung vorbei.
   */
})
