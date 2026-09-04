/**
 * Der Knopf im Eingabefeld fuehrt EINE Gepflogenheit, nicht zwei
 * gegenlaeufige.
 *
 * Gegenprobe G1, 04.09.2026, zwei Messreihen ueber je 60 s mit 120 Abtastungen
 * im Abstand von 500 ms, jede gegen `http://127.0.0.1:8127/props` gehalten:
 *
 *   D.1  Hermes anklicken, waehrend Qwen3-4B bedient. Der Knopf nennt Hermes
 *        ab 0,19 s, die Engine bedient Hermes ab 20,69 s. 20,5 s VOR der
 *        Wirklichkeit, davon 20 s lang ueber einem Port, hinter dem gar nichts
 *        laeuft.
 *   E.3  Eine LM-Studio-Zeile anklicken, waehrend die LU Engine bedient. Der
 *        Knopf nennt 12,44 s lang weiter das ALTE Modell, obwohl der
 *        Steckplatz seit 0,17 s uebergeben ist. Der Name laeuft der
 *        Wirklichkeit HINTERHER.
 *
 * "Zwei gegenlaeufige Konventionen im selben Knopf." Jetzt eine: der Knopf
 * nennt immer das angeklickte Modell, und solange es noch nicht bedient,
 * dreht sich der Ring daneben und `aria-busy` steht.
 *
 * Der Weg ueber die LU Engine schreibt die Wahl dafuer sofort in den Speicher
 * (das ist die-wahl-steht-vor-dem-warten). Der Weg zu einem fremden Backend
 * darf das nicht, weil eine dort nicht geladene Kennung mit 404 antwortet,
 * also traegt der Waehler den Namen waehrend des Wechsels selbst.
 *
 * Run: npx vitest run src/components/models/__tests__/der-knopf-nennt-immer-das-angeklickte.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, '..', 'ModelSelector.tsx'), 'utf8')

/** Der Rumpf des Knopfes, aus der Quelle geholt statt abgeschrieben. */
function knopf(): string {
  const at = SRC.indexOf('{/* ── Trigger Button ── */}')
  expect(at).toBeGreaterThan(0)
  const end = SRC.indexOf('</button>', at)
  expect(end).toBeGreaterThan(at)
  return SRC.slice(at, end)
}

describe('der Name im Knopf', () => {
  it('ist das angeklickte Modell, solange der Wechsel laeuft', () => {
    expect(SRC).toContain('const gezeigtesModell = imWechselZu ?? activeModel')
    expect(SRC).toContain('displayModelName(gezeigtesModell)')
  })

  it('der Waehler merkt sich den Klick, bevor er zu warten anfaengt', () => {
    const kopf = SRC.slice(
      SRC.indexOf('const handleSelectModel = async (model: AIModel) => {'),
      SRC.indexOf('const selectModelInner'),
    )
    expect(kopf).toContain('setImWechselZu(model.name)')
    // Und gibt ihn in JEDEM Fall wieder her, auch wenn der Wechsel scheitert.
    expect(kopf).toContain('finally')
    expect(kopf).toContain('setImWechselZu(null)')
  })

  it('und der Name steht nie ohne den drehenden Ring, wenn er noch nicht bedient', () => {
    expect(SRC).toContain('const wechselLaeuft = isModelLoading || imWechselZu !== null')
    const b = knopf()
    expect(b).toContain('aria-busy={wechselLaeuft}')
    expect(b).toContain('{wechselLaeuft ? (')
  })

  // Negativkontrolle: die alte Fassung las nur die Wahl im Speicher, und genau
  // die haengt auf dem Weg zu einem fremden Backend 12,44 s hinterher.
  it('die alte Fassung las nur den Speicher', () => {
    expect(SRC).not.toMatch(/const activeDisplayName = activeModel\s*\n\s*\?/)
    expect(knopf()).not.toContain('aria-busy={isModelLoading}')
  })
})
