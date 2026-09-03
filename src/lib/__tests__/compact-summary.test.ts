/**
 * Sperrklinken fuer die geschriebene Zusammenfassung (2.6.8, Compact-Schritt 3).
 *
 * Die Leitfrage jeder Pruefung hier ist dieselbe: was passiert, wenn das Modell
 * NICHT tut, was der Prompt verlangt? Dieses Modul wird von 4B-Modellen auf dem
 * hermes_xml- und dem template_fix-Pfad bedient — also von genau den Modellen,
 * deren Unzuverlaessigkeit der Grund fuer die Existenz dieser Pfade ist. Ein
 * Parser, der nur die brave Antwort versteht, waere hier nutzlos.
 */
import { describe, it, expect } from 'vitest'
import {
  buildCompactPrompt,
  parseCompactSummary,
  summaryFromLooseText,
  renderCompactSummary,
  stripCompactSummary,
  hasCompactSummary,
  isEmptySummary,
  isUsableSummary,
  renderTranscript,
  summaryTokens,
  applyCompactSummary,
  SECTIONS,
  COMPACT_OPEN,
  COMPACT_CLOSE,
  MAX_SUMMARY_SHARE,
  MIN_SUMMARY_CHARS,
  EMPTY_SUMMARY,
  type CompactSummary,
  minimalSummaryChars,
  summaryCouldEverFit,
  COMPACT_PREAMBLE,
  REST_HEADING,
  summarySections,
  compactSummaryBody,
} from '../compact-summary'

const brav = `TASK
Den Fehler im Login beheben.

PROGRESS
auth.ts gelesen, den Nullwert in Zeile 40 gefunden.

DECISIONS
Kein Refactoring, nur der Nullwert — der Rest ist getestet.

FACTS
src/auth.ts:40, Funktion verifyToken, Fehler "cannot read exp of undefined".

OPEN
Der Test dafuer fehlt noch.`

const summe = (s: CompactSummary) =>
  SECTIONS.map((sec) => s[sec.key]).join('') + s.rest

describe('der Prompt', () => {
  it('ist eine einzige Nutzernachricht ohne Systemanteil', () => {
    const p = buildCompactPrompt([{ role: 'user', content: 'hallo' }])
    // Der Grund steht im Modulkopf: ein Systemanteil an falscher Stelle ist
    // genau das, woran strenge Chat-Vorlagen abbrechen.
    expect(p).not.toMatch(/^system:/im)
    expect(p).toContain('--- TRANSCRIPT ---')
  })

  it('verlangt alle fuenf Abschnitte', () => {
    const p = buildCompactPrompt([{ role: 'user', content: 'x' }])
    for (const sec of SECTIONS) expect(p).toContain(sec.heading)
  })

  it('verlangt die Sprache des Gespraechs und woertliche Werte', () => {
    // Ein Persona-Lauf am 03.09.2026 fuehrte ein durchgehend deutsches
    // Gespraech und bekam eine englische Zusammenfassung zurueck, in der
    // „47,3 Millionen Euro" zu „47.3 million euros" geworden war und eine
    // Uhrzeit ganz fehlte. Beides ist derselbe Fehler: ein Protokoll, das
    // uebersetzt, ist kein Protokoll mehr, sondern eine Nacherzaehlung — und
    // Werte, die nacherzaehlt werden, sind die einzigen, die nach der
    // Verdichtung nicht mehr nachgeschlagen werden koennen.
    //
    // Eine Zusicherung auf den Wortlaut eines Prompts ist eine schwache
    // Sperrklinke, das ist mir bewusst. Sie haelt aber das eine fest, was
    // ohne sie lautlos verschwindet: dass die Anweisung ueberhaupt dasteht.
    const p = buildCompactPrompt([{ role: 'user', content: 'x' }])
    expect(p).toContain('in the language the conversation is in')
    expect(p).toMatch(/Never translate, convert or reformat a value/)
    expect(p).toMatch(/Count nothing you have not written down/)
  })

  it('nimmt einen Fokus auf, ohne die Abschnitte fallen zu lassen', () => {
    const p = buildCompactPrompt([{ role: 'user', content: 'x' }], { focus: 'die Datenbank' })
    expect(p).toContain('die Datenbank')
    for (const sec of SECTIONS) expect(p).toContain(sec.heading)
  })

  it('traegt den Verlauf, gekappt auf das Zeichenbudget', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: 'user', content: `Zug ${i} ` + 'x'.repeat(500),
    }))
    const p = buildCompactPrompt(turns, { maxTranscriptChars: 4000 })
    expect(p.length).toBeLessThan(9000)
  })
})

describe('der Verlauf wird an beiden Enden erhalten', () => {
  // Kopf-und-Fuss statt nur Kopf: die letzten Zuege vor dem Schnitt sind die,
  // auf denen das Gespraech gerade steht.
  it('behaelt Anfang UND Ende, wenn gekappt wird', () => {
    const turns = [
      { role: 'user', content: 'ERSTER ' + 'a'.repeat(3000) },
      { role: 'user', content: 'b'.repeat(3000) },
      { role: 'user', content: 'c'.repeat(3000) + ' LETZTER' },
    ]
    const t = renderTranscript(turns, 2000)
    expect(t).toContain('ERSTER')
    expect(t).toContain('LETZTER')
    expect(t).toContain('omitted')
  })

  it('laesst einen kurzen Verlauf unangetastet', () => {
    const t = renderTranscript([{ role: 'user', content: 'kurz' }], 2000)
    expect(t).toBe('user: kurz')
  })

  it('ueberspringt leere Zuege', () => {
    const t = renderTranscript([
      { role: 'user', content: 'a' }, { role: 'assistant', content: '   ' },
    ])
    expect(t).toBe('user: a')
  })
})

describe('der Parser versteht die brave Antwort', () => {
  it('trennt alle fuenf Abschnitte', () => {
    const s = parseCompactSummary(brav)
    expect(s.task).toContain('Login')
    expect(s.progress).toContain('auth.ts')
    expect(s.decisions).toContain('Refactoring')
    expect(s.facts).toContain('verifyToken')
    expect(s.open).toContain('Test')
    expect(s.rest).toBe('')
  })

  it('behaelt Bezeichner Zeichen fuer Zeichen', () => {
    const s = parseCompactSummary(brav)
    expect(s.facts).toContain('src/auth.ts:40')
    expect(s.facts).toContain('cannot read exp of undefined')
  })
})

describe('der Parser versteht die schlampige Antwort', () => {
  it('nimmt Rauten, Sterne, Doppelpunkte und Kleinschreibung', () => {
    const s = parseCompactSummary(
      '## Task:\nA\n\n**PROGRESS**\nB\n\n- decisions -\nC\n\n__Facts:__\nD\n\nopen\nE',
    )
    expect(s.task).toBe('A')
    expect(s.progress).toBe('B')
    expect(s.facts).toBe('D')
    expect(s.open).toBe('E')
  })

  it('wirft nichts weg, was vor der ersten Ueberschrift steht', () => {
    const s = parseCompactSummary('Hier meine Zusammenfassung:\n\nTASK\nA')
    expect(s.task).toBe('A')
    expect(s.rest).toContain('Hier meine Zusammenfassung')
  })

  it('behaelt eine Antwort ganz ohne Ueberschriften', () => {
    const roh = 'Der Nutzer wollte den Login reparieren, wir haben auth.ts gelesen.'
    const s = parseCompactSummary(roh)
    expect(summe(s)).toContain('auth.ts')
    expect(s.rest).toBe(roh)
  })

  it('wirft "none" weg statt es zu bezahlen', () => {
    const s = parseCompactSummary('TASK\nA\n\nDECISIONS\nnone\n\nOPEN\nNone.')
    expect(s.task).toBe('A')
    expect(s.decisions).toBe('')
    expect(s.open).toBe('')
  })

  it('haelt eine leere Antwort aus', () => {
    expect(parseCompactSummary('')).toEqual(EMPTY_SUMMARY)
    expect(isEmptySummary(parseCompactSummary('   '))).toBe(true)
  })

  it('summaryFromLooseText ist der ausdrueckliche Rueckfall', () => {
    const s = summaryFromLooseText('irgendein Text')
    expect(s.rest).toBe('irgendein Text')
    expect(isEmptySummary(s)).toBe(false)
  })
})

describe('das Rendern', () => {
  it('laesst leere Abschnitte weg', () => {
    const t = renderCompactSummary({ ...EMPTY_SUMMARY, task: 'A' })
    expect(t).toContain('TASK')
    expect(t).not.toContain('PROGRESS')
  })

  it('rahmt die Zusammenfassung ein, damit sie wiederfindbar ist', () => {
    const t = renderCompactSummary(parseCompactSummary(brav))
    expect(t.startsWith(COMPACT_OPEN)).toBe(true)
    expect(t.trimEnd().endsWith(COMPACT_CLOSE)).toBe(true)
    expect(hasCompactSummary(t)).toBe(true)
  })

  it('rendert gar nichts, wenn es nichts zu rendern gibt', () => {
    expect(renderCompactSummary(EMPTY_SUMMARY)).toBe('')
    expect(summaryTokens(EMPTY_SUMMARY)).toBe(0)
  })

  it('behaelt losen Text als eigenen Abschnitt', () => {
    const t = renderCompactSummary({ ...EMPTY_SUMMARY, task: 'A', requests: '', rest: 'Nebenbei: B' })
    expect(t).toContain('NOTES')
    expect(t).toContain('Nebenbei: B')
  })
})

describe('Zusammenfassungen stapeln sich nicht', () => {
  // Der Grund im Modulkopf: sonst faltet jede Kuerzung die vorige in sich und
  // die Genauigkeit faellt geometrisch — dieselbe Form wie beim Stapeln der
  // alten Trim-Notiz.
  it('entfernt eine frueher eingebettete Zusammenfassung', () => {
    const alt = renderCompactSummary(parseCompactSummary(brav))
    const traeger = `${alt}\n\nUnd jetzt bitte weiter mit Teil 2.`
    const sauber = stripCompactSummary(traeger)
    expect(sauber).toBe('Und jetzt bitte weiter mit Teil 2.')
    expect(hasCompactSummary(sauber)).toBe(false)
  })

  it('entfernt auch mehrere', () => {
    const a = renderCompactSummary({ ...EMPTY_SUMMARY, task: 'A' })
    const b = renderCompactSummary({ ...EMPTY_SUMMARY, task: 'B' })
    expect(stripCompactSummary(`${a}\nX\n${b}\nY`)).toBe('X\n\nY'.replace('\n\n', '\n'))
  })

  it('laesst Text ohne Zusammenfassung in Ruhe', () => {
    expect(stripCompactSummary('nur Text')).toBe('nur Text')
  })

  it('der Verlauf fuer den Zusammenfasser traegt keine alte Zusammenfassung', () => {
    const alt = renderCompactSummary(parseCompactSummary(brav))
    const t = renderTranscript([{ role: 'user', content: `${alt}\n\nweiter` }])
    expect(t).not.toContain(COMPACT_OPEN)
    expect(t).toContain('weiter')
  })
})

describe('die Brauchbarkeitspruefung — der Rueckfall auf die mechanische Kuerzung', () => {
  it('nimmt eine echte Zusammenfassung an', () => {
    const r = isUsableSummary({ summary: parseCompactSummary(brav), replacedChars: 50000 })
    expect(r.usable).toBe(true)
    expect(r.reason).toBe('ok')
  })

  it('lehnt eine leere ab', () => {
    expect(isUsableSummary({ summary: EMPTY_SUMMARY, replacedChars: 50000 }).reason).toBe('empty')
  })

  it('lehnt eine zu kurze ab', () => {
    // Gemessen werden die eigenen Worte, nicht die Verpackung: die feste
    // Vorrede der gerenderten Form ist allein schon laenger als der Boden.
    const r = isUsableSummary({ summary: { ...EMPTY_SUMMARY, task: 'ok' }, replacedChars: 50000 })
    expect(r.reason).toBe('too-short')
    expect(r.contentChars).toBeLessThan(MIN_SUMMARY_CHARS)
    expect(r.renderedChars).toBeGreaterThan(MIN_SUMMARY_CHARS)
  })

  // Der teuerste Fehlerfall: das Modell "fasst zusammen", indem es abschreibt.
  it('lehnt eine ab, die kaum kleiner ist als ihre Quelle', () => {
    const abschrift = { ...EMPTY_SUMMARY, progress: 'x'.repeat(6000) }
    const r = isUsableSummary({ summary: abschrift, replacedChars: 8000 })
    expect(r.usable).toBe(false)
    expect(r.reason).toBe('not-smaller')
  })

  it('die Grenze liegt bei der Haelfte', () => {
    const quelle = 10000
    const knappDrunter = { ...EMPTY_SUMMARY, progress: 'x'.repeat(quelle * MAX_SUMMARY_SHARE - 400) }
    expect(isUsableSummary({ summary: knappDrunter, replacedChars: quelle }).usable).toBe(true)
    const knappDrueber = { ...EMPTY_SUMMARY, progress: 'x'.repeat(quelle * MAX_SUMMARY_SHARE + 400) }
    expect(isUsableSummary({ summary: knappDrueber, replacedChars: quelle }).usable).toBe(false)
  })

  it('ohne bekannte Quellgroesse entscheidet nur der Inhalt', () => {
    expect(isUsableSummary({ summary: parseCompactSummary(brav), replacedChars: 0 }).usable).toBe(true)
  })
})

describe('das Anwenden — wo die Zusammenfassung landen darf', () => {
  const w = (role: string, content: string) => ({ role, content })
  const zus = parseCompactSummary(brav)
  const lang = () => [
    w('system', 'sei hilfreich'),
    ...Array.from({ length: 30 }, (_, i) => w(i % 2 ? 'assistant' : 'user', `zug ${i}`)),
  ]

  it('setzt die Zusammenfassung vor das behaltene Fenster', () => {
    const r = applyCompactSummary({ messages: lang(), keepRecent: 6, summary: zus })
    expect(r.replaced).toBe(24)
    expect(r.rendered).toContain(COMPACT_OPEN)
    expect(r.messages.length).toBeLessThan(lang().length)
    expect(JSON.stringify(r.messages)).toContain('verifyToken')
  })

  // Die Regel, an der diese App schon einmal gescheitert ist: eine
  // Systemnachricht mitten im Gespraech beantwortet eine strenge Jinja-Vorlage
  // mit "System message must be at the beginning" statt mit einer Antwort.
  it('erzeugt NIE eine Systemnachricht ausserhalb von Index 0', () => {
    const r = applyCompactSummary({ messages: lang(), keepRecent: 6, summary: zus })
    expect(r.messages[0].role).toBe('system')
    expect(r.messages.slice(1).some((m) => m.role === 'system')).toBe(false)
  })

  it('die Zusammenfassung reitet auf Nutzermaterial', () => {
    const r = applyCompactSummary({ messages: lang(), keepRecent: 6, summary: zus })
    const traeger = r.messages.find((m) => String(m.content).includes(COMPACT_OPEN))
    expect(traeger).toBeDefined()
    expect(traeger!.role).toBe('user')
  })

  it('kommt auch ohne Systemnachricht zurecht', () => {
    const ohne = lang().slice(1)
    const r = applyCompactSummary({ messages: ohne, keepRecent: 4, summary: zus })
    expect(r.messages.every((m) => m.role !== 'system')).toBe(true)
    expect(r.replaced).toBeGreaterThan(0)
  })

  // Ein Werkzeugergebnis ohne den Aufruf davor wird von strengen
  // OpenAI-kompatiblen Anbietern abgelehnt.
  it('laesst das behaltene Fenster nie mit einem verwaisten Werkzeugergebnis beginnen', () => {
    const msgs = [
      w('system', 's'),
      ...Array.from({ length: 20 }, (_, i) => w('user', `alt ${i}`)),
      w('tool', 'ergebnis ohne aufruf'),
      w('assistant', 'antwort'),
      w('user', 'frage'),
    ]
    const r = applyCompactSummary({ messages: msgs, keepRecent: 3, summary: zus })
    const nachTraeger = r.messages.filter((m) => !String(m.content).includes(COMPACT_OPEN))
    expect(nachTraeger[1]?.role).not.toBe('tool')
  })

  it('erkennt auch das Hermes-foermige Werkzeugergebnis', () => {
    const msgs = [
      ...Array.from({ length: 20 }, (_, i) => w('user', `alt ${i}`)),
      w('user', '<tool_response>daten</tool_response>'),
      w('assistant', 'a'),
    ]
    const r = applyCompactSummary({ messages: msgs, keepRecent: 2, summary: zus })
    expect(JSON.stringify(r.messages)).not.toContain('<tool_response>')
  })

  it('tut nichts, wenn die Zusammenfassung leer ist', () => {
    const m = lang()
    const r = applyCompactSummary({ messages: m, keepRecent: 6, summary: EMPTY_SUMMARY })
    expect(r.messages).toBe(m)
    expect(r.replaced).toBe(0)
    expect(r.rendered).toBe('')
  })

  it('tut nichts, wenn das Fenster ohnehin alles behaelt', () => {
    const m = lang()
    const r = applyCompactSummary({ messages: m, keepRecent: 999, summary: zus })
    expect(r.messages).toBe(m)
    expect(r.replaced).toBe(0)
  })

  // Sonst faltet jede Runde die vorige in sich.
  it('stapelt keine Zusammenfassungen uebereinander', () => {
    const einmal = applyCompactSummary({ messages: lang(), keepRecent: 6, summary: zus })
    const zweimal = applyCompactSummary({
      messages: [...einmal.messages, w('user', 'weiter'), w('assistant', 'ok'),
                 w('user', 'a'), w('assistant', 'b'), w('user', 'c'), w('assistant', 'd'),
                 w('user', 'e'), w('assistant', 'f')],
      keepRecent: 4,
      summary: parseCompactSummary('TASK\nNeue Fassung.\n\nOPEN\nRest.'),
    })
    const treffer = JSON.stringify(zweimal.messages).split(COMPACT_OPEN).length - 1
    expect(treffer).toBe(1)
    expect(JSON.stringify(zweimal.messages)).toContain('Neue Fassung')
  })
})

// ── Die Rechnung VOR dem Modellaufruf ──────────────────────────────────────
//
// Gefunden am 02.09.2026 im laufenden Fenster, nicht am Schreibtisch: ein
// /compact lief durch ein echtes Modell und wurde danach abgelehnt.
//
// Die erste Fassung dieser Pruefung behauptete, jener Fall sei vorher wissbar
// gewesen — und genau das hat der Test unten widerlegt: bei 633 ersetzten
// Zeichen sind 316 erlaubt, und die kleinste baubare Fassung misst 269. Sie
// haette gepasst. Abgelehnt wurde erst die wirkliche Antwort ueber zehn Turns.
//
// Die Pruefung bleibt trotzdem richtig, nur enger als gedacht: unter rund 538
// ersetzten Zeichen kann NICHTS passen. Dort spart sie einen aussichtslosen
// Modellaufruf. Der Beschwerdefall selbst wird nicht hier geloest, sondern von
// der ehrlichen Meldung in compactOutcomeMessage.
describe('was nicht passen kann, wird nicht erst gerechnet', () => {
  it('die kleinste Fassung wird gemessen, nicht geschaetzt', () => {
    // Wenn diese Zahl je als Konstante hingeschrieben wird, faellt sie hier
    // beim naechsten Umformulieren der Vorrede auf.
    expect(minimalSummaryChars()).toBeGreaterThan(COMPACT_PREAMBLE.length)
    expect(minimalSummaryChars()).toBeGreaterThanOrEqual(
      COMPACT_PREAMBLE.length + MIN_SUMMARY_CHARS,
    )
  })

  it('laesst den gemessenen Fall durch, statt ihn faelschlich vorab zu sperren', () => {
    // 633 Zeichen erlauben 316, die kleinste Fassung misst 269. Ein Nein waere
    // hier falsch gewesen: das Modell haette eine knappe Zusammenfassung
    // liefern KOENNEN. Diese Zeile haelt die Pruefung davon ab, sich zu einer
    // Sperre auszuwachsen, die gute kurze Zusammenfassungen verhindert.
    expect(summaryCouldEverFit(633)).toBe(true)
  })

  it('sperrt dort, wo es wirklich aussichtslos ist', () => {
    // Unterhalb der Schwelle passt selbst die kleinstmoegliche Fassung nicht.
    const schwelle = minimalSummaryChars() / 0.5
    expect(summaryCouldEverFit(Math.floor(schwelle) - 1)).toBe(false)
    expect(summaryCouldEverFit(200)).toBe(false)
  })

  it('sagt ja, sobald der Platz wirklich reicht', () => {
    const gerade = Math.ceil(minimalSummaryChars() / MAX_SUMMARY_SHARE)
    expect(summaryCouldEverFit(gerade)).toBe(true)
    expect(summaryCouldEverFit(gerade - 2)).toBe(false)
  })

  it('ohne Bezugsgroesse greift die Regel nicht, statt alles zu verbieten', () => {
    // 0 heisst "nicht messbar", nicht "null Platz". Ein Nein waere hier eine
    // Sperre, die niemand angeordnet hat.
    expect(summaryCouldEverFit(0)).toBe(true)
    expect(summaryCouldEverFit(-5)).toBe(true)
  })

  it('die Schranke haengt wirklich an MAX_SUMMARY_SHARE', () => {
    // Beweist, dass die Funktion die Konstante liest und nicht eine zweite,
    // still mitgefuehrte Zahl.
    const min = minimalSummaryChars()
    expect(summaryCouldEverFit(min / MAX_SUMMARY_SHARE)).toBe(true)
    expect(summaryCouldEverFit(min / MAX_SUMMARY_SHARE - 1)).toBe(false)
  })
})

// ── Aufbau und Lesen muessen dieselben Ueberschriften kennen ──────────────
//
// Gefunden am 02.09.2026 von einem Waechter, der den Rundlauf pruefen sollte.
// renderCompactSummary schrieb `NOTES`, parseCompactSummary kannte das Wort
// nicht — also fiel die Zeile samt Text in den Eimer der VORHERIGEN
// Ueberschrift. Aus {task:'A', requests: '', rest:'X'} wurde EIN TASK-Block mit dem Wort
// NOTES mittendrin. Kein Absturz, keine rote Pruefung: nur eine Anzeige, die
// still das Falsche zeigte.
//
// Der alte Waechter war gruen, weil er nur fragte, ob NOTES als ERSTE Zeile
// erscheint — das tat es nicht, es stand ja in der Mitte. Diese Pruefungen
// fragen nach dem Rundlauf selbst, und der ist die eigentliche Zusage.
describe('der Rundlauf verliert und verschiebt nichts', () => {
  it('loser Text neben benannten Abschnitten kommt als eigener Abschnitt zurueck', () => {
    const gerendert = renderCompactSummary({
      ...EMPTY_SUMMARY, task: 'Videoschnitt', requests: '', rest: 'Nebenbei: die Datei liegt auf dem NAS.',
    })
    expect(summarySections(gerendert)).toEqual([
      { heading: 'TASK', body: 'Videoschnitt' },
      { heading: REST_HEADING, body: 'Nebenbei: die Datei liegt auf dem NAS.' },
    ])
  })

  it('das Wort NOTES steht in keinem Abschnittstext, auch nicht in der Mitte', () => {
    const voll = renderCompactSummary({
      task: 'T', requests: '', progress: 'P', decisions: 'D', facts: 'F', open: 'O', rest: 'R',
    })
    for (const abschnitt of summarySections(voll)) {
      expect(abschnitt.body).not.toMatch(/^\s*NOTES\s*$/m)
    }
  })

  it('jeder Abschnitt kommt Zeichen fuer Zeichen zurueck, wie er hineinging', () => {
    const quelle = {
      task: 'Zeile eins\nZeile zwei', requests: '', progress: '- a\n- b', decisions: 'X weil Y',
      facts: '1) eins', open: 'noch offen', rest: 'loses Ende',
    }
    const zurueck = summarySections(renderCompactSummary(quelle))
    expect(zurueck.map((a) => a.body)).toEqual([
      quelle.task, quelle.progress, quelle.decisions, quelle.facts, quelle.open, quelle.rest,
    ])
  })

  it('ein Modell, das von sich aus NOTES schreibt, landet ebenfalls im Rest', () => {
    // Vorher war das Zufall: das Wort fiel in den zuletzt geoeffneten Eimer.
    const s = parseCompactSummary('TASK\nA\n\nNOTES\nB')
    expect(s.task).toBe('A')
    expect(s.rest).toBe('B')
  })
})

// ── Die Worte des Nutzers ueberleben woertlich ────────────────────────────

describe('USER REQUESTS — der einzige Abschnitt ohne zweite Quelle', () => {
  /**
   * WARUM ES DIESEN ABSCHNITT GIBT: alle anderen sind Nacherzaehlung. Eine
   * Anweisung, die einmal falsch verstanden wurde, bliebe nach der Verdichtung
   * fuer immer falsch — das Original ist weg, niemand kann nachlesen. Und
   * Nebenbedingungen ("aber nie mehr als", "ausser im normalen Chat")
   * ueberleben eine Zusammenfassung fast nie, obwohl der Nutzer die Arbeit
   * genau daran misst.
   *
   * Werkzeugausgaben lassen sich neu erzeugen, Code neu lesen. Ein Satz, den
   * der Mensch getippt hat, nicht.
   */
  it('steht in SECTIONS, direkt nach TASK', () => {
    // Die Reihenfolge traegt Bedeutung: TASK ist die Destillation, USER
    // REQUESTS das Rohprotokoll daneben. Wer sie ans Ende schoebe, liesse die
    // Nacherzaehlung zuerst lesen und das Original als Nachtrag.
    const namen = SECTIONS.map((s) => s.heading)
    expect(namen[0]).toBe('TASK')
    expect(namen[1]).toBe('USER REQUESTS')
  })

  it('der Auftrag ans Modell verlangt woertlich und verbietet Kuerzen', () => {
    const p = buildCompactPrompt([{ role: 'user', content: 'x' }])
    expect(p).toContain('USER REQUESTS')
    expect(p).toContain('in their own words, quoted exactly')
    // Die drei Verbote einzeln, weil jedes eine andere Art von Verlust ist:
    // kuerzen nimmt Nebenbedingungen, uebersetzen nimmt den Ton, aufraeumen
    // nimmt die Ungenauigkeit, an der man merkt, dass etwas offen war.
    expect(p).toContain('Do not shorten, translate or tidy them')
    // Und ausdruecklich die Nebenbedingungen, die sonst als Erstes wegfallen.
    expect(p).toMatch(/conditions and exceptions/i)
  })

  it('verbietet "none" ausgerechnet an dieser Stelle', () => {
    // Ueberall sonst ist "none" die ehrliche Antwort. Hier waere es fast immer
    // Bequemlichkeit: gesagt hat der Mensch ja etwas, sonst gaebe es kein
    // Gespraech. Ein Modell, das alle Abschnitte gleich behandelt, schreibt
    // sonst gerade den teuersten leer.
    const p = buildCompactPrompt([{ role: 'user', content: 'x' }])
    expect(p).toContain('Never write "none" under USER REQUESTS')
  })

  // Der Rundlauf geht ueber `compactSummaryBody`, und nicht aus Bequemlichkeit:
  // `parseCompactSummary` erwartet den INHALT, nicht die verpackte Fassung —
  // genau deshalb nimmt `summarySections` die Verpackung zuerst ab. Wer hier
  // direkt parst, misst einen Weg, den die App nie geht, und bekommt die
  // Vorrede im `rest` und den Schlussmarker im letzten Abschnitt zurueck.
  const rundlauf = (s: CompactSummary) =>
    parseCompactSummary(compactSummaryBody(renderCompactSummary(s)))

  it('ueberlebt den vollen Rundlauf Zeichen fuer Zeichen', () => {
    // Mit allem, was ein Aufbau kaputtmachen koennte: Zeilenumbrueche,
    // Anfuehrungszeichen, Umlaute, Kleinschreibung.
    const woertlich = '"nutze fable 5.1 aber nie mehr als 250k context"\n"gilt fuer JEDEN bereich ausser normaler chat"'
    expect(rundlauf({ ...EMPTY_SUMMARY, task: 'T', requests: woertlich }).requests)
      .toBe(woertlich)
  })

  it('faellt nicht in den Nachbarabschnitt, wenn der naechste leer ist', () => {
    // Dieselbe Falle, an der NOTES schon einmal haengengeblieben ist: eine
    // Ueberschrift, die der Aufbau schreibt und der Parser nicht kennt, nimmt
    // ihren Text in den Eimer davor mit.
    const zurueck = rundlauf({ ...EMPTY_SUMMARY, requests: 'nur dies' })
    expect(zurueck.requests).toBe('nur dies')
    expect(zurueck.task).toBe('')
    expect(zurueck.progress).toBe('')
  })

  it('bleibt woertlich, auch wenn der Text selbst wie eine Ueberschrift aussieht', () => {
    // Ein Nutzer, der "OPEN" oder "FACTS" schreibt, darf seinen Satz nicht
    // dadurch verlieren, dass der Parser ihn fuer eine Gliederung haelt. Das
    // ist keine erfundene Sorge: der Parser erkennt Ueberschriften bewusst
    // grosszuegig, mit Deko drumherum.
    const zurueck = rundlauf({
      ...EMPTY_SUMMARY,
      requests: '"schreib OPEN gross"\n"und danach FACTS pruefen"',
    })
    expect(zurueck.requests).toContain('"schreib OPEN gross"')
    expect(zurueck.requests).toContain('"und danach FACTS pruefen"')
  })
})
