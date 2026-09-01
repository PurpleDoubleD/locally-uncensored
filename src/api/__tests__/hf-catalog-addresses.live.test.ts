/**
 * T-70 · das Tor, das den Katalog gegen die Wirklichkeit prueft.
 *
 * Der Befund: ueber hundert von Hand getippte HuggingFace-Adressen, und nichts
 * hat je nachgefragt, ob es die Dateien noch gibt. Der Nutzer erfaehrt es als
 * Erster — beim Klick, nach dem Warten.
 *
 * WARUM DAS HIER STEHT UND NICHT IN DER APP. Die naheliegende Reparatur, beim
 * Start alle Adressen anzuklopfen, waere schlechter als der Befund: gut hundert
 * HEAD-Anfragen, bevor der Nutzer irgendetwas verlangt hat, und eine
 * Netzabhaengigkeit, die eine lokal laufende App nicht hatte. Offline muesste
 * so eine Pruefung entweder luegen ("alles kaputt") oder ignoriert werden, und
 * eine ignorierte Pruefung ist keine. Vor allem aber kann sie nichts
 * reparieren: die Adressen sind Konstanten. Die ausfuehrliche Begruendung steht
 * im Quelltext, Abschnitt "The catalog against reality" in discover.ts.
 *
 * Der traege Teil — die Antwort auf die Anfrage, die der Nutzer WIRKLICH
 * gestellt hat — ist bereits gebaut und kostet keine zusaetzliche Anfrage:
 * `http_error_message` (src-tauri/src/commands/download.rs) benennt den Grund,
 * `isPermanentDownloadError` nimmt den Wiederholen-Knopf weg, wo er nie helfen
 * kann. Was fehlte, ist dieses Tor: die Pruefung VOR der Auslieferung.
 *
 * Er holt nur Kopfzeilen, ein HEAD pro EINDEUTIGER Adresse, keine Nutzdaten,
 * kein Konto, keine Anmeldung. Er haengt am Netz, deshalb laeuft er nur mit
 * `LIVE_HF=1` und nicht im normalen Gate — wie der Groessen-Waechter nebenan.
 *
 *   LIVE_HF=1 npx vitest run src/api/__tests__/hf-catalog-addresses.live.test.ts
 *
 * Was er NICHT beweist: dass die Datei hinter der Adresse die richtige ist. Ein
 * HEAD sagt "da liegt etwas", nicht "da liegt das Modell, das der Katalog
 * verspricht". Die Groesse prueft der Waechter nebenan, den Inhalt nur der
 * SHA-256 beim echten Download.
 */
import { describe, it, expect } from 'vitest'
import { catalogAddresses, classifyAddressProbe, type AddressVerdict } from '../discover'
import { alleKlopfen, klopfen, BEKANNT_TOT } from './hf-live-probe'

const LIVE = process.env.LIVE_HF === '1'

interface Befund {
  url: string
  where: string[]
  status: number
  verdict: AddressVerdict
  note?: string
}

async function katalogKlopfen(): Promise<Befund[]> {
  const adressen = catalogAddresses()
  const sonden = await alleKlopfen(adressen.map((a) => a.url))
  return adressen.map((a) => {
    const s = sonden.get(a.url)
    return {
      url: a.url,
      where: a.where,
      status: s?.status ?? 0,
      verdict: s?.verdict ?? classifyAddressProbe(0),
      note: s?.note,
    }
  })
}

const zeile = (b: Befund) => `HTTP ${b.status}  ${b.url}\n      genannt von: ${b.where.join(', ')}${b.note ? `\n      ${b.note}` : ''}`

// Die Ausnahmeliste `BEKANNT_TOT` liegt in `hf-live-probe.ts`, weil der
// Groessen-Waechter sie genauso braucht: eine Adresse, die es nicht mehr gibt,
// ist dort der Grund, warum eine Datei ungemessen bleibt. Zwei Listen waeren
// zwei Chancen, still uneins zu werden.

describe.runIf(LIVE)('Katalog-Adressen gegen die echten Dateien', () => {
  it('keine Adresse des Katalogs stirbt unbemerkt', { timeout: 600_000 }, async () => {
    const befunde = await katalogKlopfen()
    const tot = befunde.filter((b) => b.verdict === 'dead')
    const unklar = befunde.filter((b) => b.verdict === 'unclear')
    const erreichbar = befunde.length - tot.length - unklar.length

    console.log(`[T-70] ${befunde.length} eindeutige Adressen geklopft · erreichbar ${erreichbar} · tot ${tot.length} · unklar ${unklar.length}`)
    for (const b of unklar) console.log(`[T-70] unklar: ${zeile(b)}`)

    // ZUERST: hat der Lauf ueberhaupt stattgefunden? Ein Tor, das gruen wird,
    // weil der Anbieter jede Anfrage abgewiesen hat, beweist nichts und ist
    // schlimmer als keins. Antwortet die Mehrheit nicht, ist der LAUF kaputt,
    // nicht der Katalog — und das muss laut gesagt werden.
    expect(
      erreichbar,
      `Nur ${erreichbar} von ${befunde.length} Adressen haben ueberhaupt geantwortet. ` +
      `Der Lauf selbst ist unbrauchbar (Netz? Ratenbremse?), er sagt nichts ueber den Katalog.\n` +
      unklar.slice(0, 5).map(zeile).join('\n'),
    ).toBeGreaterThan(befunde.length / 2)

    const neuTot = tot.filter((b) => !(b.url in BEKANNT_TOT))
    expect(
      neuTot.map(zeile),
      `Tote oder gesperrte Katalog-Adressen (${neuTot.length}):\n${neuTot.map(zeile).join('\n')}`,
    ).toEqual([])
  })

  it('die Ausnahmeliste ist keine Ablage: was wieder lebt, muss raus', { timeout: 120_000 }, async () => {
    const wiederDa: string[] = []
    for (const url of Object.keys(BEKANNT_TOT)) {
      const { status } = await klopfen(url)
      if (classifyAddressProbe(status) === 'reachable') wiederDa.push(`HTTP ${status}  ${url}`)
    }
    expect(
      wiederDa,
      `Diese Adressen antworten wieder. Raus aus BEKANNT_TOT (und den Kommentar im Katalog nachziehen):\n${wiederDa.join('\n')}`,
    ).toEqual([])
  })
})
