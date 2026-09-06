/**
 * Die App muss ihren eigenen Erinnerungs-Export wieder lesen koennen.
 *
 * Der Anlass, am 05.09.2026 am Quelltext nachgeschlagen: der Strich-Sweep
 * `01a352bf` (25.07.2026) hat im Export das Trennzeichen zwischen Titel und
 * Inhalt von einem langen Strich auf ein Komma umgestellt. Der Ausdruck im
 * Import verlangte weiter den Strich. Seitdem kam beim Zurueckladen des
 * eigenen Exports der Titel als `**Titel**, Inhalt ...` an, und Marken, Quelle
 * und Datum fielen ersatzlos weg.
 *
 * Gefunden hat es niemand, weil der einzige vorhandene Test den Import mit dem
 * ALTEN Format von Hand fuetterte (`stores.test.ts`) und kein Test je das
 * Ergebnis von `exportAsMarkdown` durch `importFromMarkdown` schickte. Genau
 * diese Luecke schliesst diese Datei: sie prueft den RUNDLAUF, nicht die
 * Bestandteile.
 *
 * Run: npx vitest run src/stores/__tests__/der-eigene-export-liest-sich-wieder-ein.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useMemoryStore } from '../memoryStore'
import type { MemoryFile } from '../../types/agent-mode'

const EINTRAG: MemoryFile = {
  id: 'rundlauf-1',
  type: 'user',
  title: 'Arbeitet auf Deutsch',
  content: 'Der Kunde schreibt und liest auf Deutsch, erwartet aber englische Fehlermeldungen, und das gilt auch fuer lange Saetze mit Komma.',
  description: 'Der Kunde schreibt und liest auf Deutsch',
  tags: ['sprache', 'wichtig'],
  source: 'david',
  createdAt: Date.UTC(2026, 6, 14),
  updatedAt: Date.UTC(2026, 6, 14),
}

function leerenUndSetzen(eintraege: MemoryFile[]) {
  useMemoryStore.setState({ entries: eintraege })
}

function rundlauf(eintraege: MemoryFile[]): MemoryFile[] {
  leerenUndSetzen(eintraege)
  const md = useMemoryStore.getState().exportAsMarkdown()
  leerenUndSetzen([])
  const zahl = useMemoryStore.getState().importFromMarkdown(md)
  expect(zahl).toBe(eintraege.length)
  return useMemoryStore.getState().entries
}

beforeEach(() => {
  leerenUndSetzen([])
})

describe('der eigene Markdown-Export laesst sich wieder einlesen', () => {
  it('HAUPTFALL: Titel, Inhalt, Marken und Quelle kommen unveraendert zurueck', () => {
    const [zurueck] = rundlauf([EINTRAG])

    expect(zurueck.title).toBe('Arbeitet auf Deutsch')
    expect(zurueck.content).toBe(EINTRAG.content)
    expect(zurueck.tags).toEqual(['sprache', 'wichtig'])
    expect(zurueck.source).toBe('david')
    expect(zurueck.type).toBe('user')
  })

  it('HAUPTFALL: der Titel ist NICHT die ganze rohe Zeile', () => {
    // Genau das war der Schaden: der Titel wurde zu `**Titel**, Inhalt ...`,
    // auf 60 Zeichen abgeschnitten, und der Inhalt trug die Auszeichnung mit.
    const [zurueck] = rundlauf([EINTRAG])

    expect(zurueck.title).not.toContain('**')
    expect(zurueck.content).not.toContain('**')
    expect(zurueck.content).not.toContain('*(david)*')
    expect(zurueck.content).not.toContain('[sprache')
  })

  it('das Datum ueberlebt den Rundlauf, weil der Export es als ISO schreibt', () => {
    const [zurueck] = rundlauf([EINTRAG])

    expect(new Date(zurueck.updatedAt).toISOString().slice(0, 10)).toBe('2026-07-14')
    expect(useMemoryStore.getState().exportAsMarkdown()).toContain('2026-07-14')
  })

  it('ein Komma im Inhalt bleibt ein Komma im Inhalt', () => {
    const mitKomma: MemoryFile = { ...EINTRAG, tags: [], source: 'import', content: 'Erst dies, dann das, und zuletzt jenes.' }
    const [zurueck] = rundlauf([mitKomma])

    expect(zurueck.content).toBe('Erst dies, dann das, und zuletzt jenes.')
  })

  it('mehrere Eintraege ueber mehrere Abschnitte finden ihren Typ wieder', () => {
    const zweiter: MemoryFile = { ...EINTRAG, id: 'rundlauf-2', type: 'feedback', title: 'Keine Striche', content: 'Nirgends ein langer Strich, auch nicht im Code.', tags: [], source: 'david' }
    const zurueck = rundlauf([EINTRAG, zweiter])

    expect(zurueck.map((e) => e.type).sort()).toEqual(['feedback', 'user'])
    expect(zurueck.find((e) => e.type === 'feedback')?.title).toBe('Keine Striche')
  })

  it('TRENNKONTROLLE: der alte Export mit dem langen Strich geht weiterhin ein', () => {
    // Wer seine Erinnerungen vor dem 25.07.2026 gesichert hat, haelt eine
    // Datei im alten Format in der Hand. Die darf nicht kaputtgehen, nur weil
    // das neue Format dazugekommen ist.
    const alt = [
      '# Memory',
      '',
      '## User',
      '',
      // Der lange Strich steht als Code-Punkt da, weil die Hausregel das
      // Zeichen selbst aus dem Baum haelt. Die Zeile ist trotzdem exakt die,
      // die der Export vor dem 25.07.2026 geschrieben hat.
      `- **Arbeitet auf Deutsch** \u2014 ${EINTRAG.content} [sprache, wichtig] *(david)* \u2014 14.07.2026`,
      '',
    ].join('\n')

    leerenUndSetzen([])
    expect(useMemoryStore.getState().importFromMarkdown(alt)).toBe(1)
    const [zurueck] = useMemoryStore.getState().entries
    expect(zurueck.title).toBe('Arbeitet auf Deutsch')
    expect(zurueck.content).toBe(EINTRAG.content)
    expect(zurueck.tags).toEqual(['sprache', 'wichtig'])
    expect(zurueck.source).toBe('david')
  })

  it('POSITIVKONTROLLE: der schlichte Strichpunkt ohne Auszeichnung geht auch ein', () => {
    leerenUndSetzen([])
    expect(useMemoryStore.getState().importFromMarkdown('## User\n\n- Ein blanker Satz ohne alles\n')).toBe(1)
    expect(useMemoryStore.getState().entries[0].content).toBe('Ein blanker Satz ohne alles')
  })
})
