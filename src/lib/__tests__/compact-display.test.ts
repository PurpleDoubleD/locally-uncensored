/**
 * Sperrklinken fuer die ANZEIGE-Haelfte der Zusammenfassung (compact-summary.ts,
 * unterer Block).
 *
 * Diese Funktionen stehen zwischen einem gespeicherten Datensatz und dem, was
 * der Nutzer im Verlauf zu sehen bekommt. Sie duerfen an genau einer Stelle
 * streng sein — beim Wegschneiden unserer EIGENEN Verpackung — und sonst
 * nirgends: ein Datensatz kann aus einer aelteren Fassung stammen, in der die
 * Marker fehlten oder die Vorrede anders lautete. Jede Strenge, die dann
 * zuschlaegt, verschluckt eine alte Zusammenfassung ganz, statt sie einfach
 * etwas roher zu zeigen. Deshalb pruefen die Tests hier vor allem, was bei
 * Eingaben passiert, die NICHT frisch aus renderCompactSummary kommen.
 */
import { describe, it, expect } from 'vitest'
import {
  compactSummaryBody,
  summarySections,
  compactionAnchors,
  renderCompactSummary,
  SECTIONS,
  COMPACT_OPEN,
  COMPACT_CLOSE,
  COMPACT_PREAMBLE,
  EMPTY_SUMMARY,
  type CompactSummary,
  type StoredCompaction,
} from '../compact-summary'

const voll: CompactSummary = {
  task: 'Den Fehler im Login beheben.',
  // Woertlich, mit Anfuehrungszeichen: genau so soll dieser Abschnitt
  // aussehen — die Worte des Nutzers, nicht ihre Nacherzaehlung.
  requests: '"mach den login fix aber ohne refactoring"',
  progress: 'auth.ts gelesen, den Nullwert in Zeile 40 gefunden.',
  decisions: 'Kein Refactoring, nur der Nullwert.',
  facts: 'src/auth.ts:40, Funktion verifyToken.',
  open: 'Der Test dafuer fehlt noch.',
  rest: '',
}

describe('compactSummaryBody — die eigene Verpackung wieder abnehmen', () => {
  it('nimmt Marker und Vorrede weg und laesst den Abschnittstext Zeichen fuer Zeichen stehen', () => {
    const gerendert = renderCompactSummary(voll)
    const body = compactSummaryBody(gerendert)

    expect(body).not.toContain(COMPACT_OPEN)
    expect(body).not.toContain(COMPACT_CLOSE)
    expect(body).not.toContain(COMPACT_PREAMBLE)
    // Der Grund, warum die Vorrede eine Konstante ist: sie wird auf einer Seite
    // geschrieben und auf der anderen wieder abgezogen. Stuende sie zweimal als
    // Text da, zeigte die Anzeige sie nach dem naechsten Umformulieren still
    // als Inhalt an.
    expect(body).not.toContain('Earlier turns in this conversation')

    // Aus SECTIONS abgeleitet, nicht von Hand hingeschrieben: die Liste der
    // Ueberschriften wuchs am 02.09.2026 um USER REQUESTS, und eine hier
    // eingetippte Reihenfolge waere in dem Moment zu einer Behauptung ueber
    // einen Aufbau geworden, den es nicht mehr gibt.
    expect(body).toBe(
      SECTIONS.map((sec) => `${sec.heading}\n${voll[sec.key]}`).join('\n\n'),
    )
    // Und woertlich heisst woertlich — Anfuehrungszeichen und Kleinschreibung
    // der Nutzernachricht stehen unveraendert da.
    expect(body).toContain('"mach den login fix aber ohne refactoring"')
    expect(body).toContain('src/auth.ts:40')
  })

  it('gibt einen Datensatz ganz ohne Marker unveraendert zurueck', () => {
    // Ein alter gespeicherter Eintrag kann aus einer Fassung ohne Marker
    // stammen. Wer hier auf den Marker besteht, zeigt dem Nutzer statt der
    // alten Zusammenfassung gar nichts — der Datensatz ist dann verloren,
    // obwohl er vollstaendig da liegt.
    expect(compactSummaryBody('TASK\nA')).toBe('TASK\nA')
    expect(compactSummaryBody('einfach nur Prosa vom Modell')).toBe('einfach nur Prosa vom Modell')
  })

  it('laesst eine fremde Vorrede stehen, statt sie blind wegzuschneiden', () => {
    // Abgezogen wird nur der Satz, den wir selbst geschrieben haben. Eine
    // andere erste Zeile ist Inhalt und bleibt Inhalt: lieber eine Zeile zu
    // viel anzeigen als den ersten Satz einer alten Zusammenfassung stumm zu
    // verlieren.
    const alt = `${COMPACT_OPEN}\nEine aeltere Vorrede stand hier.\n\nTASK\nA\n${COMPACT_CLOSE}`
    const body = compactSummaryBody(alt)
    expect(body).toBe('Eine aeltere Vorrede stand hier.\n\nTASK\nA')
  })

  it('macht aus leerer und aus reiner Leerraum-Eingabe eine leere Zeichenkette', () => {
    expect(compactSummaryBody('')).toBe('')
    expect(compactSummaryBody('   \n  \n')).toBe('')
    expect(compactSummaryBody(undefined as unknown as string)).toBe('')
  })

  it('schneidet weg, was vor dem oeffnenden und hinter dem schliessenden Marker steht', () => {
    // Die Zusammenfassung reitet auf Nutzermaterial, also steht neben ihr im
    // selben Text noch die echte Nachricht. Angezeigt werden darf nur der
    // Block zwischen den Markern.
    const traeger = `davor\n${renderCompactSummary(voll)}\ndanach`
    const body = compactSummaryBody(traeger)
    expect(body).not.toContain('davor')
    expect(body).not.toContain('danach')
    expect(body.startsWith('TASK')).toBe(true)
  })
})

describe('summarySections — die Abschnitte, wie die Anzeige sie braucht', () => {
  it('gibt nach dem vollen Rundlauf jede Ueberschrift in der Reihenfolge der Leiter zurueck', () => {
    const abschnitte = summarySections(renderCompactSummary(voll))
    expect(abschnitte.map((a) => a.heading)).toEqual(SECTIONS.map((s) => s.heading))
    for (const sec of SECTIONS) {
      const treffer = abschnitte.find((a) => a.heading === sec.heading)
      expect(treffer?.body).toBe(voll[sec.key])
    }
  })

  it('laesst leere Abschnitte ganz weg, statt eine Ueberschrift ohne Text zu zeigen', () => {
    const halb: CompactSummary = {
      ...EMPTY_SUMMARY,
      task: 'Den Login reparieren.',
      requests: '', decisions: 'Kein Refactoring.',
      open: 'Der Test fehlt.',
    }
    const abschnitte = summarySections(renderCompactSummary(halb))
    expect(abschnitte).toEqual([
      { heading: 'TASK', body: 'Den Login reparieren.' },
      { heading: 'DECISIONS', body: 'Kein Refactoring.' },
      { heading: 'OPEN', body: 'Der Test fehlt.' },
    ])
    expect(abschnitte.some((a) => a.heading === 'PROGRESS')).toBe(false)
    expect(abschnitte.some((a) => a.heading === 'FACTS')).toBe(false)
  })

  it('zeigt bei reinem losen Text kein NOTES als erste Zeile', () => {
    // NOTES ist unser eigenes Wort, nicht das des Modells: der Aufbau schreibt
    // es als Ueberschrift, aber es steht nicht in SECTIONS. Steht es im Text
    // der Anzeige, sieht es aus wie ein Formatfehler des Modells, obwohl wir
    // es selbst hingeschrieben haben.
    const nurRest: CompactSummary = { ...EMPTY_SUMMARY, rest: 'Der Build ist rot, sonst nichts.' }
    const abschnitte = summarySections(renderCompactSummary(nurRest))

    expect(abschnitte).toEqual([{ heading: 'NOTES', body: 'Der Build ist rot, sonst nichts.' }])
    for (const a of abschnitte) expect(a.body.split('\n')[0].trim()).not.toBe('NOTES')
  })

  it('zeigt auch neben benannten Abschnitten kein NOTES als erste Zeile — und verliert den losen Text nicht', () => {
    const gemischt: CompactSummary = {
      ...EMPTY_SUMMARY,
      task: 'Den Login reparieren.',
      requests: '', open: 'Der Test fehlt.',
      rest: 'Nebenbei: der Build ist rot.',
    }
    const abschnitte = summarySections(renderCompactSummary(gemischt))

    for (const a of abschnitte) expect(a.body.split('\n')[0].trim()).not.toBe('NOTES')
    // Der lose Text ist der Teil, den das Modell unter keine Ueberschrift
    // gebracht hat. Genau der darf auf dem Weg in die Anzeige nicht
    // verschwinden — sonst faellt weg, was am wenigsten vorhersehbar war.
    expect(abschnitte.map((a) => a.body).join('\n')).toContain('Nebenbei: der Build ist rot.')
    expect(abschnitte.some((a) => a.heading === 'TASK' && a.body === 'Den Login reparieren.')).toBe(true)
  })

  it('schneidet eine allein stehende NOTES-Zeile aus einem alten Datensatz heraus', () => {
    // Ein gespeicherter Eintrag, der mit der NOTES-Ueberschrift beginnt, ohne
    // dass eine benannte Ueberschrift davor steht. Der Parser kennt NOTES
    // nicht, das Wort landet also im Rest — hier wird es weggeschnitten, damit
    // die Anzeige nicht "NOTES" ueber dem Text NOTES stehen hat.
    const alt = `${COMPACT_OPEN}\n${COMPACT_PREAMBLE}\n\nNOTES\nDer Build ist rot.\n${COMPACT_CLOSE}`
    expect(summarySections(alt)).toEqual([{ heading: 'NOTES', body: 'Der Build ist rot.' }])
  })

  it('gibt bei unlesbarer Eingabe eine leere Liste zurueck, damit die Komponente ihren Rueckfall zeigt', () => {
    expect(summarySections('')).toEqual([])
    expect(summarySections('   \n\n  ')).toEqual([])
    expect(summarySections(`${COMPACT_OPEN}\n${COMPACT_PREAMBLE}\n${COMPACT_CLOSE}`)).toEqual([])
    expect(summarySections(renderCompactSummary(EMPTY_SUMMARY))).toEqual([])
  })
})

describe('compactionAnchors — an welcher sichtbaren Zeile die Linie haengt', () => {
  const m = (id: string, role = 'user') => ({ id, role })
  const alle = [m('m1'), m('m2', 'assistant'), m('sys1', 'system'), m('m3'), m('m4', 'assistant')]
  const sichtbar = ['m1', 'm2', 'm3', 'm4']
  const satz = (summary: string, upToMessageId: string): StoredCompaction => ({ summary, upToMessageId })

  it('haengt die Linie an die letzte SICHTBARE Nachricht, wenn der Schnittpunkt unsichtbar ist', () => {
    // Fall 1. Der Schnitt kann auf einer Systemnachricht liegen, die der
    // Verlauf wegfiltert. Ohne diesen Rueckwaertsgang faende die Anzeige gar
    // keine Zeile und zeigte die Verdichtung gar nicht an — obwohl sie
    // stattgefunden hat.
    const karte = compactionAnchors(alle, sichtbar, [satz('S', 'sys1')])
    expect([...karte.keys()]).toEqual(['m2'])
    expect(karte.get('m2')?.map((r) => r.summary)).toEqual(['S'])
  })

  it('haengt die Linie an den Schnittpunkt selbst, wenn der sichtbar ist', () => {
    const karte = compactionAnchors(alle, sichtbar, [satz('S', 'm3')])
    expect([...karte.keys()]).toEqual(['m3'])
  })

  it('ueberspringt einen Datensatz, dessen Schnittpunkt geloescht ist', () => {
    // Fall 2. Ein Ersatzanker oben oder unten waere schlimmer als keine Linie:
    // eine Linie an der falschen Stelle behauptet ueber den Verlauf etwas, was
    // nicht stimmt — naemlich dass ab HIER die Zusammenfassung gilt.
    const karte = compactionAnchors(alle, sichtbar, [satz('S', 'laengst-geloescht')])
    expect(karte.size).toBe(0)
    expect(karte.has('m1')).toBe(false)
    expect(karte.has('m4')).toBe(false)
  })

  it('ueberspringt auch einen Datensatz, vor dem ueberhaupt nichts Sichtbares liegt', () => {
    const nurSystemVorne = [m('sys0', 'system'), m('sys1', 'system'), m('m3')]
    const karte = compactionAnchors(nurSystemVorne, ['m3'], [satz('S', 'sys1')])
    expect(karte.size).toBe(0)
  })

  it('gibt bei zwei Datensaetzen auf derselben Zeile BEIDE zurueck, in ihrer Reihenfolge', () => {
    // Fall 3. Nur den letzten zu zeigen verschwiege genau die Information, um
    // die es geht: dass zweimal verdichtet wurde.
    const karte = compactionAnchors(alle, sichtbar, [satz('erste', 'm2'), satz('zweite', 'sys1')])
    const liste = karte.get('m2')
    expect(liste).toHaveLength(2)
    expect(liste?.map((r) => r.summary)).toEqual(['erste', 'zweite'])
    expect(karte.size).toBe(1)
  })

  it('gibt eine leere Karte zurueck, wenn es nichts zu verankern gibt', () => {
    expect(compactionAnchors(alle, sichtbar, undefined).size).toBe(0)
    expect(compactionAnchors(alle, sichtbar, []).size).toBe(0)
    expect(compactionAnchors(alle, [], [satz('S', 'm1')]).size).toBe(0)
    expect(compactionAnchors([], sichtbar, [satz('S', 'm1')]).size).toBe(0)
  })
})
