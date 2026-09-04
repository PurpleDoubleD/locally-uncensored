/**
 * "Connected" darf nicht heissen "der Port hat geantwortet".
 *
 * Persona-Befund vom 03.09.2026: der Test-Knopf bei einem Anbieter meldete
 * Connected, obwohl gar kein Chat moeglich war, und er pruefe wohl nur den
 * GET-Pfad. Nachgemessen im laufenden Build, mit einem OpenAI-kompatiblen
 * Anbieter, dessen `GET /v1/models` mit 200 und einer LEEREN Liste antwortet:
 *
 *   M3-leer  Connected sichtbar: true   Failed sichtbar: false
 *   M3b-eins Connected sichtbar: true   Failed sichtbar: false
 *
 * Zweimal dasselbe Wort fuer zwei sehr verschiedene Lagen. Und die Diagnose
 * der Persona stimmte: `OpenAiProvider.checkConnection` holt `${baseUrl}/models`
 * und gibt `res.ok` zurueck, `OllamaProvider.checkConnection` dasselbe mit
 * `/tags`. Ein LM Studio mit laufendem Server ohne geladenes Modell und ein
 * frisches Ollama ohne einen einzigen Pull antworten beide 200.
 *
 * Run: npx vitest run src/lib/__tests__/erreichbar-ist-nicht-chatbereit.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { reachVerdict } from '../builtin-slot-status'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('reachVerdict', () => {
  it('DER FEHLER: erreichbar mit null Modellen ist nicht connected', () => {
    expect(reachVerdict(true, 0)).toBe('no-models')
  })

  it('erreichbar mit Modellen bleibt connected', () => {
    expect(reachVerdict(true, 1)).toBe('connected')
    expect(reachVerdict(true, 42)).toBe('connected')
  })

  it('nicht erreichbar bleibt failed, egal was die Liste sagt', () => {
    expect(reachVerdict(false, 0)).toBe('failed')
    expect(reachVerdict(false, 7)).toBe('failed')
    expect(reachVerdict(false, null)).toBe('failed')
  })

  it('eine nicht beantwortbare Liste redet ein gemessenes Connected nicht kaputt', () => {
    // Anthropic hat keinen Listenendpunkt, und ein Fehler beim Holen ist kein
    // Beweis fuer null Modelle. Unwissen darf nichts behaupten.
    expect(reachVerdict(true, null)).toBe('connected')
  })
})

describe('beide Wege der Anbieterzeile sprechen denselben Spruch', () => {
  const src = read('../../components/settings/ProviderConfig.tsx')

  it('der Test-Knopf faellt sein Urteil ueber reachVerdict', () => {
    expect(src).toMatch(/const verdict = reachVerdict\(ok, ok \? await countModels\(providerId\) : null\)/)
    // Das alte Urteil war genau die Zeile, die zweimal Connected sagte.
    expect(src).not.toMatch(/ok \? 'connected' : 'failed'/)
  })

  it('der Aufschlag beim Oeffnen faellt dasselbe Urteil', () => {
    // Sonst sagt die Zeile beim Oeffnen etwas anderes als nach dem Klick, und
    // das ist genau die Sorte Widerspruch, aus der Meldungen wie diese
    // entstehen.
    expect(src).toMatch(/return reachVerdict\(reachable, reachable \? await countModels\(id\) : null\)/)
  })

  it('eine leere Liste steht in englischem Klartext auf dem Schirm', () => {
    expect(src).toContain('Reachable, no models')
    expect(src).toMatch(/testid: 'provider-no-models'/)
    // Und die vier Lagen teilen sich eine Zeile, statt sie viermal
    // abzuschreiben. Die vierte war eine Abschrift der dritten, und die
    // Typo-Sperrklinke hat das gemerkt, bevor jemand sonst es tat.
    expect(src.match(/function Statusfeld\(/g) ?? []).toHaveLength(1)
  })

  it('eine leere Liste ist nicht gruen und nicht rot, sondern ruhig', () => {
    // Diese Regel hat sich am 04.09.2026 geaendert, der Sinn nicht. Vorher
    // stand hier `status === 'stopped' || status === 'no-models' ?
    // 'bg-amber-500'`, und das pruefte dasselbe: nicht gruen, weil Gruen auf
    // dieser Zeile "du kannst chatten" heisst, und nicht rot, weil der Server
    // laeuft. Das Gelb dafuer ist weg, weil es im ganzen Haus der Sammelplatz
    // fuer alles war, was weder gut noch kaputt ist, und damit nichts mehr
    // aussagte (die Begruendung steht in lib/hinweis.ts). Der Punkt kennt
    // jetzt drei Farben, und 'no-models' faellt in die ruhige.
    expect(src).toMatch(
      /status === 'connected' \? PUNKT_FARBE\.an :\s*status === 'failed' \? PUNKT_FARBE\.kaputt :\s*PUNKT_FARBE\.aus/,
    )
    // Das Wort daneben traegt denselben Ton wie der Punkt.
    expect(src).toMatch(/text: 'Reachable, no models',\s*ton: HINWEIS_TEXT\.ruhig/)
    // NEGATIVKONTROLLE: kein Gelb mehr in dieser Datei, in keiner Schreibweise
    // und auch nicht in einem Kommentar.
    expect(src).not.toMatch(/amber-|yellow-/)
    // Und die leere Liste darf sich auch nicht in die Gegenrichtung verirren.
    expect(src).not.toMatch(/'no-models'[^\n]*(?:green|emerald|red)-/)
  })

  it('die gesunde Maschine aus GH #118 bleibt stumm, solange sie steht', () => {
    // Die Verfeinerung haengt sich NUR an ein 'connected'. Ein gestoppter
    // Motor faehrt weiterhin keine Anfrage gegen einen Port, auf dem niemand
    // lauscht. Das war der ganze Sinn von readBuiltinSlotStatus.
    expect(src).toMatch(/known === 'connected' \? reachVerdict\(true, await countModels\(id\)\) : known/)
  })
})

describe('die Meldung war richtig: der Pfad ist wirklich nur ein GET', () => {
  it('OpenAI-kompatibel prueft /models und liest nur res.ok', () => {
    const p = read('../../api/providers/openai-provider.ts')
    const block = p.slice(p.indexOf('async checkConnection('))
    expect(block.slice(0, 400)).toMatch(/\$\{this\.baseUrl\}\/models/)
    expect(block.slice(0, 400)).toMatch(/return res\.ok/)
  })

  it('Ollama prueft /tags und liest nur res.ok', () => {
    const p = read('../../api/providers/ollama-provider.ts')
    const block = p.slice(p.indexOf('async checkConnection('))
    expect(block.slice(0, 300)).toMatch(/apiUrl\('\/tags'\)/)
    expect(block.slice(0, 300)).toMatch(/return res\.ok/)
  })
})
