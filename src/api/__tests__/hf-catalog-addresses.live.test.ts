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

const LIVE = process.env.LIVE_HF === '1'

/** Gleichzeitige Anfragen. Klein gehalten: das Tor soll den Anbieter nicht
 *  aergern, und ein 429 macht die Antwort wertlos statt rot. */
const PARALLEL = 4
const TIMEOUT_PRO_ANFRAGE_MS = 20_000

interface Befund {
  url: string
  where: string[]
  status: number
  verdict: AddressVerdict
  note?: string
}

async function klopfen(url: string): Promise<{ status: number; note?: string }> {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_PRO_ANFRAGE_MS),
    })
    return { status: r.status }
  } catch (err) {
    // Kein Netz, DNS weg, Zeit abgelaufen: das ist keine Aussage ueber die
    // Adresse. Status 0 laeuft durch classifyAddressProbe auf 'unclear'.
    return { status: 0, note: String(err) }
  }
}

async function alleKlopfen(): Promise<Befund[]> {
  const adressen = catalogAddresses()
  const befunde: Befund[] = []
  let naechste = 0
  const arbeiter = Array.from({ length: PARALLEL }, async () => {
    for (let i = naechste++; i < adressen.length; i = naechste++) {
      const a = adressen[i]
      const { status, note } = await klopfen(a.url)
      befunde.push({ url: a.url, where: a.where, status, verdict: classifyAddressProbe(status), note })
    }
  })
  await Promise.all(arbeiter)
  return befunde
}

const zeile = (b: Befund) => `HTTP ${b.status}  ${b.url}\n      genannt von: ${b.where.join(', ')}${b.note ? `\n      ${b.note}` : ''}`

/**
 * Adressen, die nachweislich tot sind und fuer die es KEINEN geprueften Ersatz
 * gibt. Sie stehen hier, damit ein Tor, das an ihnen dauerhaft rot waere, kein
 * Tor mehr waere — ein dauerhaft rotes Gate wird ignoriert, und dann faellt
 * die naechste Adresse, die stirbt, niemandem mehr auf.
 *
 * Die Liste kann nicht zum Friedhof werden: der zweite Test unten wird ROT,
 * sobald eine Adresse von hier wieder antwortet. Wer einen Eintrag hier
 * ablegt, muss den Grund im Katalog selbst dokumentieren.
 */
const BEKANNT_TOT: Record<string, string> = {
  'https://huggingface.co/huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-GGUF/resolve/main/DeepSeek-V4-Flash-UD-IQ1_M.gguf':
    'Repo privat oder geloescht (HTTP 401), kein geprueftes Ersatz-Repo · Begruendung bei den Eintraegen in discover.ts',
  'https://huggingface.co/huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-GGUF/resolve/main/ggml-model-Q3_K_S.gguf':
    'Repo privat oder geloescht (HTTP 401), kein geprueftes Ersatz-Repo · Begruendung bei den Eintraegen in discover.ts',
}

describe.runIf(LIVE)('Katalog-Adressen gegen die echten Dateien', () => {
  it('keine Adresse des Katalogs stirbt unbemerkt', { timeout: 600_000 }, async () => {
    const befunde = await alleKlopfen()
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
