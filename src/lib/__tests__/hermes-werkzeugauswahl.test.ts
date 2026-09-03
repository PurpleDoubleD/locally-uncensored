/**
 * Der Hermes-Pfad wählt Werkzeuge wie der native — nicht anders.
 *
 * ── WORUM ES GEHT ──────────────────────────────────────────────────────────
 *
 * Es gibt zwei Wege, einem Modell zu sagen, welche Werkzeuge es hat:
 *
 *   native      Die Liste reist als eigenes Feld `tools` auf der Leitung.
 *   hermes_xml  Das Modell kann dieses Feld nicht, also werden die JSON-
 *               Schemata als TEXT in den Systemprompt geschrieben.
 *
 * Der native Zweig sortiert vorher aus: `selectRelevantToolsAsync` nimmt, was
 * zur Frage passt, und deckelt unter Small-Model-Mode auf
 * SMALL_MODEL_MAX_TOOLS. Der Hermes-Zweig tat das bis 2026-09-02 NICHT — er
 * nahm alles, was die Berechtigungen durchliessen.
 *
 * ── WARUM DAS GENAU HERUM FALSCH WAR ───────────────────────────────────────
 *
 * `hermes_xml` ist kein Weg, den man waehlt, sondern der RUECKFALL fuer
 * Modelle, deren Template kein natives Werkzeug-Feld kann
 * (agent-strategy.ts: `applyLiveCapabilities`). Das ist strukturell die
 * SCHWAECHSTE Population — und die bekam die LAENGSTE Liste, waehrend die
 * starken Modelle die kurze bekamen.
 *
 * Am 02.09.2026 auf der Entwicklermaschine nachgemessen:
 *
 *   Katalog nach dem 2.6.6-Schnitt          17 Werkzeuge
 *   Hermes-Prompt daraus                    19.459 Zeichen  ≈ 4.866 Token
 *   davon die Werkzeugliste (<tools>)       18.347 Zeichen  ← 94,3 %
 *   davon die Huelle (Anweisungstext)        1.112 Zeichen  ←  5,7 %
 *
 *   smollm2:135m / 360m melden Ollama nur `completion`, kein `tools`
 *   → hermes_xml. Trainiertes Fenster 8192, Sendefenster unter
 *   Small-Model-Mode min(8192 × 0,5, 6000) = 4.096 Token.
 *
 *   4.866 von 4.096 = 119 %. Die Werkzeugliste ALLEIN passte nicht ins
 *   Sendefenster, bevor ein einziges Wort Gespraech dazukam.
 *
 * ── WAS DIE FORSCHUNG DAZU SAGT ────────────────────────────────────────────
 *
 * Bei 4B–14B-Modellen bricht die Werkzeugtreffsicherheit oberhalb von etwa 15
 * in den Prompt geschriebenen Schemata auf 0–49 % ein; retrieval-gestuetzte
 * Vorauswahl hob sie in einer Messung von 13,6 % auf 43 %. Wir standen bei 17.
 *
 * ── DIE SORGE, DIE HIER MITGEPRUEFT WIRD ───────────────────────────────────
 *
 * Ein Deckel nimmt dem Modell Werkzeuge weg — kommt es dann nicht mehr ans
 * siebte? Zwei Antworten, beide unten als Zusicherung:
 *
 *   1. Der native Zweig routet in JEDER Iteration auf dasselbe `userContent`
 *      (useAgentChat.ts:1007, ein nie neu belegter Funktionsparameter). Es
 *      gibt dort also gar keine "zweite Runde", in der nachjustiert wuerde.
 *      Der Deckel auf Hermes stellt Gleichstand her, statt etwas zu nehmen.
 *   2. Wer ein Werkzeug woertlich beim Namen nennt, schiebt es am Deckel
 *      vorbei (`mentionedToolNames` → `pinned` in applyMaxTools).
 *
 * Lauf: npx vitest run src/lib/__tests__/hermes-werkzeugauswahl.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolRegistry, DEFAULT_PERMISSIONS, registerBuiltinTools } from '../../api/mcp'
import { buildHermesToolPrompt } from '../../api/hermes-tool-calling'
import {
  selectRelevantToolsAsync,
  toolSelectionOpts,
  SMALL_MODEL_MAX_TOOLS,
} from '../tool-selection'
import { effectiveSendWindow } from '../send-window'
import { estimateTokens } from '../context-compaction'

const here = dirname(fileURLToPath(import.meta.url))
const lies = (p: string) => readFileSync(resolve(here, '../..', p), 'utf8')

/** Das kleinste Fenster, das ein Hermes-Modell hier real bekommt: smollm2, 8k. */
const KLEINSTES_MODELLFENSTER = 8192

const kleinstesSendefenster = () =>
  effectiveSendWindow({
    providerId: 'ollama',
    modelWindow: KLEINSTES_MODELLFENSTER,
    capEnabled: true,
    smallModelMode: true,
  })

function katalog() {
  registerBuiltinTools(toolRegistry)
  return toolRegistry.getAll()
}

const FRAGE = 'count the ts files under src'

describe('Der ungefilterte Katalog passt nicht — der Grund fuer diese Datei', () => {
  it('die volle Liste sprengt das kleinste Hermes-Sendefenster', () => {
    katalog()
    // Diese Zusicherung behauptet NICHT, dass der Code das tut. Sie haelt die
    // MESSUNG fest, aus der die Aenderung folgt: wer den Deckel spaeter wieder
    // entfernt, kommt genau hier heraus und liest, warum es ihn gibt.
    const voll = toolRegistry.toHermesToolDefs(DEFAULT_PERMISSIONS)
    const prompt = buildHermesToolPrompt(voll)
    const fenster = kleinstesSendefenster()

    expect(voll.length).toBeGreaterThan(SMALL_MODEL_MAX_TOOLS)
    expect(estimateTokens(prompt)).toBeGreaterThan(fenster)
  })

  it('die Huelle ist NICHT das Problem — sie ist ein Zwanzigstel', () => {
    katalog()
    // Der Kommentar, der die Auslassung bis 2026-09-02 begruendete, sagte:
    // "The Hermes-XML branch already uses a tight tool prompt". Das stimmt und
    // beantwortet die falsche Frage: eng ist die Anweisung drumherum, nicht
    // die Liste darin.
    //
    // Gemessen wird die Huelle WIE AUSGELIEFERT — nicht `buildHermesToolPrompt([])`.
    // Die leere Huelle sind 543 Zeichen, aber drei Absaetze darin haengen an
    // `has(name)` (todo_write, web_search+web_fetch, file_edit) und entstehen
    // erst mit den Werkzeugen. Wer die LEERE Huelle abzieht, schlaegt diese 569
    // Zeichen der Liste zu und macht den Befund groesser, als er ist: 97,2 %
    // statt der wahren 94,3 %. Der Befund traegt auch ohne diese Aufrundung.
    const voll = toolRegistry.toHermesToolDefs(DEFAULT_PERMISSIONS)
    const ganz = buildHermesToolPrompt(voll)
    const anfang = ganz.indexOf('\n<tools>\n') + '\n<tools>\n'.length
    // `lastIndexOf` fuer das Ende: die ERSTE Zeile des Prompts nennt
    // "<tools></tools>" selbst, ein vorwaerts suchendes indexOf faende dort ein
    // leeres Paar und maesse die Huelle als 100 %.
    const liste = ganz.slice(anfang, ganz.lastIndexOf('\n</tools>\n'))
    expect(liste.length).toBeGreaterThan(0)
    expect((ganz.length - liste.length) / ganz.length).toBeLessThan(0.1)
  })
})

describe('Nach der Auswahl passt es', () => {
  it('die ausgewaehlte Liste passt ins kleinste Sendefenster', async () => {
    const gewaehlt = await selectRelevantToolsAsync(
      FRAGE, katalog(), DEFAULT_PERMISSIONS, toolSelectionOpts(true),
    )
    const prompt = buildHermesToolPrompt(gewaehlt)
    // Mit Luft: die Liste darf hoechstens die HAELFTE des Sendefensters
    // belegen, sonst bleibt fuer Systemprompt, Verlauf und die Frage selbst
    // nichts uebrig. Sie war vorher bei 119 %.
    expect(estimateTokens(prompt)).toBeLessThan(kleinstesSendefenster() / 2)
  })

  it('haelt den Deckel des nativen Zweigs ein', async () => {
    const gewaehlt = await selectRelevantToolsAsync(
      FRAGE, katalog(), DEFAULT_PERMISSIONS, toolSelectionOpts(true),
    )
    expect(gewaehlt.length).toBeLessThanOrEqual(SMALL_MODEL_MAX_TOOLS)
  })

  it('ein woertlich genanntes Werkzeug kommt am Deckel vorbei', async () => {
    // Die Notausfahrt, ohne die der Deckel wirklich etwas wegnaehme. Sie
    // steckt in applyMaxTools (`pinned`) und gilt fuer beide Zweige.
    const gewaehlt = await selectRelevantToolsAsync(
      'use web_fetch to read https://example.com',
      katalog(), DEFAULT_PERMISSIONS, toolSelectionOpts(true),
    )
    expect(gewaehlt.map((t) => t.name)).toContain('web_fetch')
  })

  it('ohne Small-Model-Mode wird gefiltert, aber nicht gedeckelt', async () => {
    // Die Vorauswahl gilt auf BEIDEN Stufen — der Deckel nur unten. Ein
    // grosses Modell auf dem Rueckfallweg (kaputtes Template, viel Fenster)
    // soll seine Auswahl behalten, aber trotzdem keine 17 Schemata lesen
    // muessen, von denen 11 nichts mit der Frage zu tun haben.
    const gross = await selectRelevantToolsAsync(
      FRAGE, katalog(), DEFAULT_PERMISSIONS, toolSelectionOpts(false),
    )
    expect(gross.length).toBeGreaterThan(SMALL_MODEL_MAX_TOOLS)
    expect(gross.length).toBeLessThanOrEqual(katalog().length)
  })
})

describe('Beide Zweige benutzen dieselben Stellschrauben', () => {
  const quelle = () => lies('hooks/useAgentChat.ts')

  it('der Hermes-Zweig waehlt aus, statt den Katalog zu nehmen', () => {
    const t = quelle()
    // Die eigentliche Zusicherung: die Zuweisung an `hermesToolDefs` geht
    // durch die Auswahl. Auf `selectRelevantToolsAsync` allein zu pruefen
    // waere zahnlos — die Zeile steht ja auch im nativen Zweig.
    expect(t).toMatch(/hermesToolDefs\s*=\s*[\s\S]{0,200}selectRelevantToolsAsync\(/)
    expect(t).not.toMatch(/hermesToolDefs\s*=\s*toolRegistry\s*\n?\s*\.toHermesToolDefs\(/)
  })

  it('keiner der beiden Zweige buchstabiert die Stellschrauben selbst aus', () => {
    // Der Grund, warum es `toolSelectionOpts` gibt und nicht zwei Objektliterale:
    // die Abweichung, die diese Datei behebt, ist genau so entstanden. Ein
    // zweites Literal irgendwo laesst die Zweige beim naechsten Umbau wieder
    // auseinanderlaufen, ohne dass etwas bricht.
    const t = quelle()
    expect(t).not.toContain('embeddingThreshold:')
    expect(t).not.toContain('maxTools: SMALL_MODEL_MAX_TOOLS')
    // Beide Aufrufe holen sie aus der einen Quelle.
    const treffer = t.match(/toolSelectionOpts\(/g) ?? []
    expect(treffer.length).toBeGreaterThanOrEqual(2)
  })

  it('die Vorauswahl bekommt dieselbe Werkzeugmenge wie nativ', () => {
    // `toolRegistry.getAll()` plus derselbe curated/readOnly-Filter. Wer hier
    // `getAvailableTools` einsetzte, veraenderte nichts an den Rechten
    // (selectRelevantToolsAsync filtert `blocked` selbst), wohl aber die
    // Vergleichbarkeit der beiden Zweige.
    const t = quelle()
    // Fenster fester Laenge hinter jedem Aufruf statt einer Klammer-Regex:
    // ein nicht-gieriges `\)` haelt schon beim ersten `getAll()` an und der
    // Waechter prueft dann nur den Anfang des Aufrufs.
    const stellen: number[] = []
    for (let i = t.indexOf('selectRelevantToolsAsync('); i !== -1; i = t.indexOf('selectRelevantToolsAsync(', i + 1)) {
      stellen.push(i)
    }
    expect(stellen).toHaveLength(2)
    for (const i of stellen) {
      const fenster = t.slice(i, i + 400)
      expect(fenster).toContain('toolRegistry.getAll()')
      expect(fenster).toContain('toolMatchesCurated')
      expect(fenster).toContain('toolSelectionOpts(')
    }
  })
})
