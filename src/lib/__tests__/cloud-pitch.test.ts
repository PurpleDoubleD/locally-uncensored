/**
 * Das Argument des Wolkenschalters.
 *
 * Die Zahlen selbst haengen an scripts/check-cloud-sales.mjs, das sie gegen
 * den Katalog im Web-Repo haelt. Hier steht, was die Zeilen SAGEN muessen:
 * die richtige Reihenfolge, kein Versprechen ohne Bedingung, keine Zahl, die
 * nicht aus der Konstante kommt.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CLOUD_PITCH,
  CLOUD_SUBSCRIBER_LINE,
  HOSTED_CREDITS_PER_EUR,
  SUBSCRIBER_CREDIT_FACTOR,
  cloudPitchLines,
  cloudSalesLines,
} from '../cloud-pitch'

/**
 * R2-47: drei Zeilen, nie vier. Eine vierte Zeile faellt hier auf, bevor sie
 * an der Oberflaeche steht.
 */
describe('cloud pitch', () => {
  it('is exactly three lines', () => {
    expect(cloudPitchLines()).toHaveLength(3)
  })

  it('leads with what the models may do, then the price, then the equipment', () => {
    // R2-47: erst zaehlen, dann lesen. Bis 3.0.0 pruefte der Waechter drei
    // Zeilen inhaltlich und zaehlte sie nie, waehrend CloudGateModal jede Zeile
    // rendert, die er bekommt: eine vierte stuende ungeprueft im Kaufmoment.
    expect(cloudPitchLines()).toHaveLength(3)
    const [first, second, third] = cloudPitchLines()
    expect(first).toMatch(/without refusing/i)
    expect(second).toMatch(/no credits/i)
    expect(third).toMatch(/image and .* video/i)
  })

  it('never promises unmetered without naming the paid plan and the ceiling', () => {
    const line = cloudPitchLines()[1]
    expect(line).toMatch(/paid plan/i)
    expect(line).toContain(CLOUD_PITCH.flashDailyTokens.toLocaleString('en-US'))
  })

  it('calls the measurement a measurement', () => {
    expect(cloudPitchLines()[0]).toMatch(/measured, not guessed/i)
  })

  it('takes every number from the constant, never from a typed-out string', () => {
    const doubled = cloudPitchLines({
      ...CLOUD_PITCH,
      unfilteredChatModels: CLOUD_PITCH.unfilteredChatModels + 1,
      imageModels: CLOUD_PITCH.imageModels + 1,
    })
    expect(doubled[0]).toContain(String(CLOUD_PITCH.unfilteredChatModels + 1))
    expect(doubled[2]).toContain(String(CLOUD_PITCH.imageModels + 1))
  })

  /**
   * R6-7: "12 of them" stand direkt hinter den 27 gemessenen Modellen und las
   * sich als genau die Schnittmenge aus gemessen-ohne-Ablehnung und
   * Flash-Klasse. Diese Schnittmenge ist NIRGENDS gemessen. Die Zeile nennt
   * deshalb den Katalog, auf den sich die 12 wirklich beziehen, und der
   * Rueckbezug darf nicht zurueckkommen.
   */
  it('never claims the intersection of the measured set and the free class', () => {
    // Die Schnittmenge, die niemand kennt. Sie steht hier als eigene Groesse,
    // damit sichtbar ist, dass sie fehlt und nicht etwa 12 ist.
    const SCHNITTMENGE_FLASH_UND_FULL: number | null = null
    expect(SCHNITTMENGE_FLASH_UND_FULL, 'ungemessen, also unbehauptbar').toBeNull()

    const line = cloudPitchLines()[1]
    expect(line).not.toMatch(/\bof them\b/i)
    expect(line).toContain(String(CLOUD_PITCH.chatModels))
    // Die Zeile davor traegt den Messnenner, diese den Katalog. Zwei Nenner,
    // zwei Mengen.
    expect(cloudPitchLines()[0]).toContain(String(CLOUD_PITCH.measuredChatModels))
  })

  it('the sales panel says three things, in the order the order named them', () => {
    expect(cloudSalesLines()).toEqual([
      '13 No Filter chat models',
      '17 uncensored video models',
      '9 uncensored image models',
    ])
  })

  it('and takes all three numbers from the constant, never from a typed string', () => {
    const verschoben = cloudSalesLines({
      ...CLOUD_PITCH,
      unfilteredChatModels: CLOUD_PITCH.unfilteredChatModels + 1,
      openVideoModels: CLOUD_PITCH.openVideoModels + 1,
      openImageModels: CLOUD_PITCH.openImageModels + 1,
    })
    expect(verschoben[0]).toContain(String(CLOUD_PITCH.unfilteredChatModels + 1))
    expect(verschoben[1]).toContain(String(CLOUD_PITCH.openVideoModels + 1))
    expect(verschoben[2]).toContain(String(CLOUD_PITCH.openImageModels + 1))
  })

  /**
   * Die beiden offenen Zahlen sind Teilmengen ihrer Gattung, und zwei
   * verschiedene Mengen.
   *
   * Die Falle, gegen die das hier steht: der Medienkatalog traegt die offenen
   * Bild- UND Videomodelle unter demselben Flag. Wer alle `adult: true`-Zeilen
   * zaehlt und die Summe als Videozahl ausgibt, nennt die Bildmodelle zweimal,
   * einmal als Video und einmal in der Zeile darunter. Keine der beiden Zahlen
   * darf darum je ihre eigene Gattung ueberschreiten.
   */
  it('counts two separate sets, each inside its own kind', () => {
    expect(CLOUD_PITCH.openVideoModels).toBeLessThanOrEqual(CLOUD_PITCH.videoModels)
    expect(CLOUD_PITCH.openImageModels).toBeLessThanOrEqual(CLOUD_PITCH.imageModels)
    // Und die Summe steht nirgends als eine der beiden Zahlen.
    const summe = CLOUD_PITCH.openVideoModels + CLOUD_PITCH.openImageModels
    expect(cloudSalesLines()[1]).not.toContain(String(summe))
    expect(cloudSalesLines()[2]).not.toContain(String(summe))
  })
})

/**
 * Der Abo-Satz und die Zahl darin.
 *
 * Er steht zeichengleich auf vier Flaechen (Verkaufs-Panel, Versionsblatt,
 * CHANGELOG, Dialog beim leeren Beutel) und im Web-Repo noch einmal auf vier.
 * Der Faktor wird geteilt, nie getippt.
 */
describe('der Abo-Satz', () => {
  it('steht auf dem Stand, den jemand von Hand gesetzt hat', () => {
    // Die Packstufen gehoeren dem Web-Repo und stehen nicht in dieser Datei,
    // also kann der Faktor hier nicht geteilt werden. Er wird doppelt
    // gehalten: hier ausgeschrieben, und vor jedem Release aus den lebenden
    // Tabellen des Web-Repos geteilt (scripts/check-cloud-sales.mjs).
    expect(SUBSCRIBER_CREDIT_FACTOR).toBe(1.5)
    expect(HOSTED_CREDITS_PER_EUR).toBe(CLOUD_PITCH.hostedCredits / CLOUD_PITCH.hostedMonthlyEUR)
  })

  it('fuehrt keine Packgroessen, damit es keine zweite Wahrheit gibt', () => {
    // Der Storno vom 13.09.2026: die Stufen werden gerade neu gesetzt. Ein
    // Desktop, der sie mitfuehrt, traegt ab dem naechsten Entscheid die
    // veraltete Fassung, und niemand merkt es, weil nichts sie vergleicht.
    const quelle = readFileSync(resolve(__dirname, '..', 'cloud-pitch.ts'), 'utf8')
    expect(quelle, 'eine Packtabelle ist zurueck').not.toMatch(/eurCents/)
    expect(quelle, 'eine Packgroesse steht im Quelltext').not.toMatch(/\b(150_000|310_000|800_000|230_000|465_000|1_175_000)\b/)
  })

  it('haelt die Toleranz 1,4 bis 1,6', () => {
    expect(SUBSCRIBER_CREDIT_FACTOR).toBeGreaterThanOrEqual(1.4)
    expect(SUBSCRIBER_CREDIT_FACTOR).toBeLessThanOrEqual(1.6)
  })

  it('lautet genau so, und beide Zahlen kommen aus Konstanten', () => {
    expect(CLOUD_SUBSCRIBER_LINE).toBe(
      'Subscribers get about 1.5x more credits per euro and 500,000 free Flash tokens a day.',
    )
    expect(CLOUD_SUBSCRIBER_LINE).toContain(`${SUBSCRIBER_CREDIT_FACTOR.toFixed(1)}x`)
    expect(CLOUD_SUBSCRIBER_LINE).toContain(CLOUD_PITCH.flashDailyTokens.toLocaleString('en-US'))
    expect(CLOUD_SUBSCRIBER_LINE).not.toMatch(/[–—]/u)
  })

  /**
   * NEGATIVKONTROLLE. Mit der Pakettabelle vom 10.09.2026 ergibt dieselbe
   * Rechnung 1,0, und der Satz haette nicht geschrieben werden duerfen. Ohne
   * diese Zeile waere auch ein Lauf gruen, der nie etwas gerechnet hat.
   */
  /**
   * NEGATIVKONTROLLE fuer die Rechnung, die der Satz behauptet.
   *
   * Ohne sie waere gruen auch ein Lauf, der nie etwas gerechnet hat. Gerechnet
   * wird gegen KURSE, nicht gegen Packgroessen: welche Stufen gerade gelten,
   * weiss allein das Web-Repo, und diese Datei soll es nicht wissen.
   */
  it('erkennt einen Kurs, bei dem der Satz nicht mehr traegt', () => {
    const faktorBei = (packRate: number) =>
      Math.round((HOSTED_CREDITS_PER_EUR / packRate) * 10) / 10

    // Ein Paket dicht am Abo-Kurs: der Satz waere falsch. Genau das war die
    // Lage am 10.09.2026, als ein Paket auf Abo-Niveau gesetzt wurde.
    expect(faktorBei(47_000)).toBe(1)
    expect(faktorBei(47_000)).toBeLessThan(1.4)

    // Ein Paket, das das Abo ueberholt: erst recht falsch.
    expect(faktorBei(HOSTED_CREDITS_PER_EUR * 1.2)).toBeLessThan(1.4)

    // Und ein Kurs, bei dem der Satz traegt.
    expect(faktorBei(32_000)).toBe(1.5)
    expect(faktorBei(32_000)).toBe(SUBSCRIBER_CREDIT_FACTOR)
  })

  it('sagt nie, wie viele Tokens das Geld kauft', () => {
    // Harte Regel vom 10.09.2026. Credits je Euro duerfen, Tokens je Geld nie.
    expect(CLOUD_SUBSCRIBER_LINE).not.toMatch(/tokens?\s+(for|per)\s+(euro|€|\d)/i)
  })
})

describe('cloud pitch, Rest', () => {
  it('claims nothing the catalogue cannot carry', () => {
    expect(CLOUD_PITCH.unfilteredChatModels).toBeLessThanOrEqual(CLOUD_PITCH.measuredChatModels)
    expect(CLOUD_PITCH.measuredChatModels).toBeLessThanOrEqual(CLOUD_PITCH.chatModels)
    expect(CLOUD_PITCH.flashModels).toBeLessThanOrEqual(CLOUD_PITCH.chatModels)
    // Gemessen wurde jedes Modell des Messlaufs genau einmal: ganz, teilweise
    // oder gar nicht. Markierte plus zurueckhaltende koennen den Messlauf
    // deshalb nicht ueberschreiten.
    expect(CLOUD_PITCH.unfilteredChatModels + CLOUD_PITCH.heldBackChatModels)
      .toBeLessThanOrEqual(CLOUD_PITCH.measuredChatModels)
    for (const line of cloudPitchLines()) expect(line).not.toMatch(/[–—]/u)
  })
})
