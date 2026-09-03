/**
 * Wer suchen darf, muss auch lesen duerfen — und wer am Projekt arbeitet,
 * braucht kein Web-Paar.
 *
 * ── DER BEFUND ─────────────────────────────────────────────────────────────
 *
 * Gefunden am 02.09.2026 beim Nachmessen des Hermes-Werkzeugdeckels, an einer
 * ganz gewoehnlichen Frage:
 *
 *   "was ist die hauptstadt von frankreich"
 *     → todo_write, file_read, file_write, file_edit, web_search, file_list
 *
 * `web_search` ist dabei, `web_fetch` nicht. Das Modell bekommt eine Suche und
 * keinen Weg, die gefundenen Seiten zu lesen.
 *
 * ── WARUM DAS SCHLIMMER IST, ALS ES KLINGT ─────────────────────────────────
 *
 * Der Hermes-Systemprompt haengt seine Warnung an das PAAR
 * (api/hermes-tool-calling.ts, `has('web_search') && has('web_fetch')`):
 *
 *   "IMPORTANT: web_search returns ONLY short snippets, NOT real data. You
 *    MUST ALWAYS call web_fetch on the best URL to read actual page content
 *    before answering."
 *
 * Faellt `web_fetch` aus der Auswahl, verschwindet also GENAU der Satz, der
 * erklaert, warum Snippets keine Antwort sind — zusammen mit dem Werkzeug, das
 * das Problem loesen wuerde. Uebrig bleibt ein Modell, das aus Suchschnipseln
 * antwortet und nicht weiss, dass es das nicht sollte. Das ist die Bauform, aus
 * der erfundene Antworten mit echt aussehenden Quellen entstehen.
 *
 * ── DER ERSTE FIX WAR ZU KURZ, UND DAS IST DER LEHRSATZ ────────────────────
 *
 * Zuerst stand hier eine Zeile: "hat er web_search, kriegt er web_fetch dazu".
 * Sie hielt das Paar zusammen und machte den Coding-Zug kaputt. Gemessen unter
 * dem Small-Model-Deckel (SMALL_MODEL_MAX_TOOLS = 6, vier davon belegt, also
 * zwei freie Plaetze) fuer "fix the current bug in auth.ts":
 *
 *   vorher          … web_search, file_list
 *   ein Zeile Fix   … web_search, web_fetch      ← file_list weg
 *   richtig         … file_list, file_search     ← und gar kein Web
 *
 * Zwei bestehende Sperren in tool-selection.test.ts ("coding intent routing")
 * wurden davon rot — zu Recht. Ihre Begruendung: ein Coding-Zug ohne
 * file_search/file_list "hat keine Moeglichkeit, Dateien zu finden".
 *
 * Bemerkenswert ist, WIE sie gruen waren: sie pruefen `not.toContain('web_fetch')`
 * und nannten das "loest die Web-Gruppe nicht aus". `web_search` war da aber
 * laengst. Sie haben eine Haelfte des Paares als Stellvertreter fuer das ganze
 * Paar bewacht — und genau die andere Haelfte war der Fehler.
 *
 * ── DIE URSACHE ────────────────────────────────────────────────────────────
 *
 * TOOL_GROUPS fuehrt die beiden korrekt als Paar. Aufgebrochen wird es eine
 * Ebene tiefer, im generischen Rueckfall von `selectRelevantTools`, der
 * `web_search` ALLEIN in jede unerkannte Nachricht wirft. Und "unerkannt" traf
 * auch klare Projektarbeit: "fix the current bug in auth.ts" trifft zwar die
 * Gruppe fuer 'fix', aber deren Werkzeuge (file_write, file_edit) stehen
 * ohnehin in ALWAYS_INCLUDE — die MENGE wuchs nicht, der Rueckfall sah vier
 * Namen und hielt die Nachricht fuer generisch.
 *
 * Der Fix merkt sich deshalb, ob eine Gruppe fuer LOKALE Arbeit getroffen hat
 * (`lokaleArbeit`), und gibt das Web-Paar nur dann, wenn keine getroffen hat.
 * Zusaetzlich bleibt die Einzeiler-Sicherung als zweites Netz stehen, fuer die
 * Wege, die den Rueckfall gar nicht nehmen (Verbatim-Erwaehnung).
 *
 * Lauf: npx vitest run src/lib/__tests__/web-suchen-heisst-web-lesen.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  selectRelevantTools, selectRelevantToolsAsync, toolSelectionOpts, SMALL_MODEL_MAX_TOOLS,
} from '../tool-selection'
import { toolRegistry, DEFAULT_PERMISSIONS, registerBuiltinTools } from '../../api/mcp'
import { buildHermesToolPrompt } from '../../api/hermes-tool-calling'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function katalog() {
  registerBuiltinTools(toolRegistry)
  return toolRegistry.getAll()
}

const namen = (ts: { name: string }[]) => ts.map((t) => t.name)

/** Fragen, die im generischen Rueckfall landen — keine trifft eine Werkzeuggruppe. */
const GENERISCH = [
  'was ist die hauptstadt von frankreich',
  'help me with this project',
  'erklaer mir das mal',
]

/** Nachrichten, die erkennbar von diesem Rechner handeln. */
const LOKAL = [
  'fix the current bug in auth.ts',
  'search the codebase for the auth handler and refactor it',
  'refactor the auth guard and run the tests',
]

describe('Das Web-Paar bleibt zusammen', () => {
  it.each(GENERISCH)('%s — mit web_search kommt web_fetch', (frage) => {
    const gewaehlt = namen(selectRelevantTools(frage, katalog(), DEFAULT_PERMISSIONS))
    if (!gewaehlt.includes('web_search')) return // diese Frage zieht gar kein Web-Werkzeug
    expect(gewaehlt).toContain('web_fetch')
  })

  it('auch unter dem Small-Model-Deckel ueberlebt das Paar', async () => {
    // Der Deckel ist SMALL_MODEL_MAX_TOOLS = 6, davon sind 4 durch
    // ALWAYS_INCLUDE belegt. Es bleiben zwei Plaetze — genau die Groesse des
    // Paares. Faellt hier einer weg, ist der Fix oben wirkungslos, weil der
    // Deckel danach kommt.
    const gewaehlt = namen(await selectRelevantToolsAsync(
      'was ist die hauptstadt von frankreich', katalog(), DEFAULT_PERMISSIONS, toolSelectionOpts(true),
    ))
    expect(gewaehlt.length).toBeLessThanOrEqual(SMALL_MODEL_MAX_TOOLS)
    if (!gewaehlt.includes('web_search')) return
    expect(gewaehlt).toContain('web_fetch')
  })

  it('die Warnung im Hermes-Prompt steht wieder da', async () => {
    // Die eigentliche Wirkung, und der Grund, warum das kein Schoenheitsfehler
    // war: der Absatz haengt an `has('web_search') && has('web_fetch')`.
    const gewaehlt = await selectRelevantToolsAsync(
      'was ist die hauptstadt von frankreich', katalog(), DEFAULT_PERMISSIONS, toolSelectionOpts(true),
    )
    const prompt = buildHermesToolPrompt(gewaehlt)
    if (!namen(gewaehlt).includes('web_search')) return
    expect(prompt).toContain('web_search returns ONLY short snippets')
    expect(prompt).toContain('web_fetch')
  })
})

describe('Und es kommt nicht ungefragt', () => {
  it.each(LOKAL)('%s — bekommt GAR kein Web-Werkzeug', (frage) => {
    // Beide Haelften, nicht nur web_fetch. Genau diese Luecke hat die alten
    // Sperren jahrelang gruen gehalten, waehrend web_search laengst mitfuhr.
    const gewaehlt = namen(selectRelevantTools(frage, katalog(), DEFAULT_PERMISSIONS))
    expect(gewaehlt).not.toContain('web_search')
    expect(gewaehlt).not.toContain('web_fetch')
  })

  it.each(LOKAL)('%s — behaelt unter dem Deckel die Dateisuche', async (frage) => {
    // Die teuerste Stelle: hier sind nur zwei Plaetze frei, und wenn das
    // Web-Paar sie nimmt, kann ein kleines Modell im Projekt nichts mehr
    // finden. Gemessen war genau das der Preis des ersten Fixes.
    const gewaehlt = namen(await selectRelevantToolsAsync(
      frage, katalog(), DEFAULT_PERMISSIONS, toolSelectionOpts(true),
    ))
    expect(gewaehlt).toContain('file_list')
    expect(gewaehlt).toContain('file_search')
  })

  it('auch die Verbatim-Erwaehnung bekommt beide Haelften', () => {
    // Der Weg, der den Rueckfall gar nicht nimmt, und der einzige, auf dem das
    // zweite Netz ueberhaupt noch etwas tut: wer "web_search" woertlich nennt,
    // trifft keine Schluesselwortgruppe (die kennt nur 'web search' mit
    // Leerzeichen), sondern die Verbatim-Schleife — und die nennt eine Haelfte.
    //
    // Ohne diese Zusicherung waere von der Zeile unten nur der Quelltext
    // bewacht und nicht ihre Wirkung.
    const gewaehlt = namen(selectRelevantTools(
      'nimm web_search dafuer', katalog(), DEFAULT_PERMISSIONS,
    ))
    expect(gewaehlt).toContain('web_search')
    expect(gewaehlt).toContain('web_fetch')
  })

  it('das Netz vervollstaendigt nur in EINE Richtung', () => {
    // Meine erste Fassung hat hier zugesichert, dass "use web_fetch to read
    // https://example.com" KEIN web_search bekommt — und war rot, bevor ich
    // irgendetwas geaendert hatte. Der Grund ist kein Fehler: der Satz trifft
    // eine Web-Schluesselwortgruppe, und TOOL_GROUPS fuehrt die beiden dort
    // gemeinsam. Das ist richtig so und aelter als dieser Fix.
    //
    // Was diese Zusicherung wirklich festhalten soll, ist die Richtung des
    // zweiten Netzes: es fuegt web_fetch zu web_search hinzu, nie andersherum.
    // Sonst zoege jedes einzelne web_fetch ein web_search nach sich und
    // kostete unter dem Sechser-Deckel einen von zwei freien Plaetzen.
    const quelle = readFileSync(resolve(here, '../tool-selection.ts'), 'utf8')
    expect(quelle).toContain("if (selectedNames.has('web_search')) selectedNames.add('web_fetch')")
    expect(quelle).not.toContain("if (selectedNames.has('web_fetch')) selectedNames.add('web_search')")
  })
})
