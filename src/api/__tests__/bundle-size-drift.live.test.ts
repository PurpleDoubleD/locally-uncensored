import { describe, it, expect } from 'vitest'
import { getImageBundles, getVideoBundles } from '../discover'
import { alleKlopfen, BEKANNT_TOT, istBekanntTot, type HfSonde } from './hf-live-probe'

/**
 * Waechter fuer die Groessenangaben der Buendel.
 *
 * Die Zahl neben einer Datei ist kein Schmuck. Nach ihr entscheidet der Nutzer,
 * ob er den Download startet, und danach raeumt er vorher auf oder eben nicht.
 * Am 15.08.2026 stand beim FramePack-Modell 13 GB, die Datei hat 16,3 GB. Auf
 * der Testmaschine lief die Platte auf 0 Byte, der Rechner war danach nicht
 * mehr benutzbar, und die halbe Datei blieb liegen.
 *
 * Der Lauf holt nur die Kopfzeilen, ein HEAD pro EINDEUTIGER Adresse, keine
 * Nutzdaten. Er haengt am Netz und an HuggingFace, deshalb laeuft er nur mit
 * `LIVE_SIZES=1` und nicht im normalen Gate, genau wie der Preis-Waechter der
 * Cloud.
 *
 *   LIVE_SIZES=1 npx vitest run src/api/__tests__/bundle-size-drift.live.test.ts
 *
 * ── 01.09.2026: DIESER TEST HAT SICH SELBST ABGESCHALTET ──
 *
 * Bis heute stand hier `if (echt === null) continue`, und `echteGroesse` gab
 * `null` fuer JEDE Nicht-OK-Antwort zurueck. Eine Adresse, die 404 sagt, wurde
 * also stillschweigend uebersprungen, und der Lauf meldete gruen weiter. Ein
 * toter Katalogeintrag konnte damit direkt neben einem laufenden Live-Test
 * sitzen und blieb unsichtbar — so ist der 404 des Vision-Projektors der sechs
 * Qwen-3.8-27B-Eintraege stehen geblieben, bis das Adress-Tor nebenan ihn fand.
 *
 * "Ich konnte nicht messen" und "die Groesse stimmt" sind nicht dasselbe.
 * Nichts wird mehr still uebersprungen: jede Datei landet in genau einem
 * benannten Topf, die Toepfe werden gezaehlt und ausgegeben, und ihre Summe
 * muss den ganzen Katalog ergeben. Was der Lauf nicht messen konnte, steht am
 * Ende mit Grund da.
 */
const LIVE = process.env.LIVE_SIZES === '1'

type Datei = { name: string; downloadUrl?: string; sizeGB?: number }

const dateien = (): Datei[] => {
  const alle: Datei[] = []
  for (const b of [...getImageBundles(), ...getVideoBundles()]) {
    for (const f of b.files ?? []) alle.push(f as Datei)
  }
  return alle
}

/**
 * Der Katalog zaehlt in Gibibyte, also so, wie Windows und der Finder den
 * freien Platz anzeigen. Genau damit vergleicht der Nutzer, und nur dann hilft
 * ihm die Zahl. Ein Vergleich gegen die Dezimal-GB der Kopfzeile wuerde jeden
 * Eintrag anmeckern und dabei die echten Faelle verstecken.
 */
const GIB = 1024 ** 3

// Rundung auf eine Nachkommastelle plus etwas Luft. Was darunter liegt, ist
// Anzeigegenauigkeit, kein Planungsfehler.
const TOLERANZ_GIB = 0.15

/** Jede Datei landet in genau einem Topf. Kein stilles `continue` mehr. */
interface Toepfe {
  /** Wirklich gemessen — nur hier kann der Waechter etwas beweisen. */
  gemessen: string[]
  /** Gemessen und zu niedrig angekuendigt. Der eigentliche Befund. */
  zuKlein: string[]
  /** Kein Download (Ollama-Tag) oder keine angekuendigte Groesse. Nichts zu pruefen. */
  nichtsAngekuendigt: string[]
  /** Adresse tot, und die Ausnahmeliste kennt sie NICHT. Rot. */
  totUnbekannt: string[]
  /** Adresse tot, aber dokumentiert und quarantaeniert (siehe hf-live-probe.ts). */
  totBekannt: string[]
  /** Anbieter hat nicht geantwortet (Ratenbremse, 5xx, kein Netz). */
  unklar: string[]
  /** Erreichbar, aber ohne `content-length` — messbar war es trotzdem nicht. */
  ohneLaenge: string[]
}

function einordnen(dateiListe: Datei[], sonden: Map<string, HfSonde>): Toepfe {
  const t: Toepfe = { gemessen: [], zuKlein: [], nichtsAngekuendigt: [], totUnbekannt: [], totBekannt: [], unklar: [], ohneLaenge: [] }
  for (const f of dateiListe) {
    if (!f.downloadUrl || f.sizeGB === undefined) { t.nichtsAngekuendigt.push(f.name); continue }
    const s = sonden.get(f.downloadUrl)
    if (!s) { t.unklar.push(`${f.name}: nicht geklopft`); continue }
    if (s.verdict === 'dead') {
      const zeile = `${f.name}: HTTP ${s.status} · ${f.downloadUrl}`
      if (istBekanntTot(f.downloadUrl)) t.totBekannt.push(`${zeile}\n      ${BEKANNT_TOT[f.downloadUrl]}`)
      else t.totUnbekannt.push(zeile)
      continue
    }
    if (s.verdict === 'unclear') { t.unklar.push(`${f.name}: HTTP ${s.status}${s.note ? ` · ${s.note}` : ''}`); continue }
    if (s.bytes === null) { t.ohneLaenge.push(`${f.name}: HTTP ${s.status} ohne content-length`); continue }
    const echtGiB = s.bytes / GIB
    t.gemessen.push(f.name)
    if (echtGiB > f.sizeGB + TOLERANZ_GIB) {
      t.zuKlein.push(`${f.name}: angekuendigt ${f.sizeGB}, echt ${echtGiB.toFixed(2)}`)
    }
  }
  return t
}

describe.runIf(LIVE)('Buendel-Groessen gegen die echten Dateien', () => {
  it('keine Datei ist groesser als angekuendigt — und was ungemessen blieb, wird benannt', { timeout: 300_000 }, async () => {
    const liste = dateien()
    const sonden = await alleKlopfen(liste.map((f) => f.downloadUrl).filter((u): u is string => !!u))
    const t = einordnen(liste, sonden)

    const summe = t.gemessen.length + t.nichtsAngekuendigt.length + t.totUnbekannt.length
      + t.totBekannt.length + t.unklar.length + t.ohneLaenge.length
    console.log(
      `[Groessen] ${liste.length} Katalogdateien (${sonden.size} eindeutige Adressen) · gemessen ${t.gemessen.length}`
      + ` · nichts angekuendigt ${t.nichtsAngekuendigt.length} · tot bekannt ${t.totBekannt.length}`
      + ` · tot unbekannt ${t.totUnbekannt.length} · unklar ${t.unklar.length} · ohne content-length ${t.ohneLaenge.length}`,
    )
    for (const z of t.totBekannt) console.log(`[Groessen] ungemessen, tote Adresse aus der Quarantaene: ${z}`)
    for (const z of t.unklar) console.log(`[Groessen] ungemessen, Anbieter schwieg: ${z}`)
    for (const z of t.ohneLaenge) console.log(`[Groessen] ungemessen, keine Laenge: ${z}`)

    // Die Buchhaltung muss aufgehen. Faellt eine Datei durch alle Toepfe, ist
    // genau das wieder ein stiller Uebersprung.
    expect(summe, 'jede Katalogdatei muss in genau einem Topf landen').toBe(liste.length)

    // Hat der Lauf ueberhaupt stattgefunden? Gruen, weil der Anbieter jede
    // Anfrage abgewiesen hat, ist schlimmer als rot.
    const messbar = liste.length - t.nichtsAngekuendigt.length
    expect(
      t.gemessen.length,
      `Nur ${t.gemessen.length} von ${messbar} Dateien konnten gemessen werden. Der Lauf sagt nichts ueber den Katalog.`,
    ).toBeGreaterThan(messbar / 2)

    // Eine tote Adresse ist kein Groessenproblem, aber sie ist der Grund,
    // warum diese Datei ungeprueft bleibt — und das war frueher unsichtbar.
    // Wer sie nicht reparieren kann, dokumentiert sie im Katalog und traegt
    // sie in BEKANNT_TOT ein; dann faellt sie oben in den benannten Topf und
    // das Adress-Tor haelt sie im Blick.
    expect(
      t.totUnbekannt,
      `Adressen, deren Groesse nicht geprueft werden konnte, weil es sie nicht mehr gibt:\n${t.totUnbekannt.join('\n')}`,
    ).toEqual([])

    expect(t.zuKlein, `Zu niedrig angegeben (GiB):\n${t.zuKlein.join('\n')}`).toEqual([])
  })
})
