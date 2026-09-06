/**
 * Die EINE Sonde, mit der die Live-Waechter HuggingFace anfassen.
 *
 * Es gab zwei. Das Adress-Tor (`hf-catalog-addresses.live.test.ts`) hatte
 * seine, der Groessen-Waechter (`bundle-size-drift.live.test.ts`) seine — und
 * die beiden waren sich uneins darueber, was eine Nicht-OK-Antwort bedeutet.
 * Der Groessen-Waechter behandelte jede davon gleich (`if (echt === null)
 * continue`) und lief gruen weiter. Ein 404 im Katalog konnte deshalb neben
 * einem laufenden Live-Test sitzen und Erfolg melden — genau so ist der tote
 * Vision-Projektor der sechs Qwen-3.8-27B-Eintraege monatelang stehen
 * geblieben, bis das Adress-Tor ihn am 01.09.2026 im ersten Lauf fand.
 *
 * Zwei Kopien sind zwei Chancen, still uneins zu werden. Also eine Sonde, ein
 * Urteil, eine Ausnahmeliste. Das Urteil selbst kommt aus `classifyAddressProbe`
 * in discover.ts, damit auch der Download-Pfad der App dasselbe unter "kaputt"
 * versteht wie die Waechter.
 *
 * Keine Testdatei (kein `.test.ts`), damit vitest sie nicht einsammelt.
 */
import { classifyAddressProbe, type AddressVerdict } from '../discover'

/** Gleichzeitige Anfragen. Klein gehalten: die Waechter sollen den Anbieter
 *  nicht aergern, und eine Ratenbremse macht ihre Antwort wertlos statt rot. */
export const PARALLEL = 4
export const TIMEOUT_PRO_ANFRAGE_MS = 20_000

export interface HfSonde {
  url: string
  status: number
  verdict: AddressVerdict
  /** Byte-Zahl aus `content-length`, wenn der Anbieter eine genannt hat. */
  bytes: number | null
  /** Warum es keine Antwort gab (Netz, DNS, Zeit) — nur bei Status 0. */
  note?: string
}

/** Ein HEAD, keine Nutzdaten, kein Konto, keine Anmeldung. */
export async function klopfen(url: string): Promise<HfSonde> {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_PRO_ANFRAGE_MS),
    })
    const len = r.headers.get('content-length')
    return { url, status: r.status, verdict: classifyAddressProbe(r.status), bytes: len ? Number(len) : null }
  } catch (err) {
    // Kein Netz, DNS weg, Zeit abgelaufen: das ist keine Aussage ueber die
    // Adresse. Status 0 laeuft durch classifyAddressProbe auf 'unclear'.
    return { url, status: 0, verdict: classifyAddressProbe(0), bytes: null, note: String(err) }
  }
}

/** Eine Anfrage pro EINDEUTIGER Adresse — dieselbe Datei steckt in mehreren
 *  Buendeln, und viermal dasselbe zu fragen kostet nur den Anbieter. */
export async function alleKlopfen(urls: Iterable<string>): Promise<Map<string, HfSonde>> {
  const liste = [...new Set(urls)]
  const raus = new Map<string, HfSonde>()
  let naechste = 0
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let i = naechste++; i < liste.length; i = naechste++) {
      const s = await klopfen(liste[i])
      raus.set(s.url, s)
    }
  }))
  return raus
}

/**
 * Adressen, die nachweislich tot sind und fuer die es KEINEN geprueften Ersatz
 * gibt. Sie stehen hier, damit ein Waechter, der an ihnen dauerhaft rot waere,
 * kein Waechter mehr waere — ein dauerhaft rotes Gate wird ignoriert, und dann
 * faellt die naechste Adresse, die stirbt, niemandem mehr auf.
 *
 * EINE Liste fuer beide Waechter. Die Liste kann nicht zum Friedhof werden:
 * das Adress-Tor wird ROT, sobald eine Adresse von hier wieder antwortet. Wer
 * einen Eintrag hier ablegt, muss den Grund im Katalog selbst dokumentieren.
 */
export const BEKANNT_TOT: Record<string, string> = {
  'https://huggingface.co/huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-GGUF/resolve/main/DeepSeek-V4-Flash-UD-IQ1_M.gguf':
    'Repo privat oder geloescht (HTTP 401), kein geprueftes Ersatz-Repo · Begruendung bei den Eintraegen in discover.ts',
  'https://huggingface.co/huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-GGUF/resolve/main/ggml-model-Q3_K_S.gguf':
    'Repo privat oder geloescht (HTTP 401), kein geprueftes Ersatz-Repo · Begruendung bei den Eintraegen in discover.ts',
}

export const istBekanntTot = (url: string): boolean => url in BEKANNT_TOT
