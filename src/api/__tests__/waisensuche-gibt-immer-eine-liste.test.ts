/**
 * Die Waisensuche muss eine Liste zurueckgeben, immer.
 *
 * Der Aufrufer ist `downloadStore.scanOrphans`, und er liest sofort `.length`.
 * Kommt von der Gegenstelle etwas anderes als eine Liste zurueck, riss der
 * Suchlauf dort auseinander, und weil `scanOrphans` niemand erwartet, landete
 * das als unbehandelte Zurueckweisung im Log statt in einer Meldung. Im Lauf
 * der Testsuite waren das sieben Stueck.
 *
 * Ein fehlgeschlagener Suchlauf heisst "es liegt nichts herum", nicht "der
 * Nutzer bekommt einen Fehler". Deshalb steht der Waechter an der Grenze und
 * nicht im Speicher: es gibt genau eine Stelle, an der die Antwort ankommt.
 *
 * Run: npx vitest run src/api/__tests__/waisensuche-gibt-immer-eine-liste.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', () => ({ backendCall: vi.fn() }))

import { backendCall } from '../backend'
import { findOrphanDownloads } from '../discover'

const ruf = vi.mocked(backendCall)

beforeEach(() => { ruf.mockReset() })

describe('was die Gegenstelle auch schickt', () => {
  it('alles, was keine Liste ist, wird zu einem leeren Ergebnis', async () => {
    for (const antwort of [null, undefined, 'nope', { stem: 'x' }, 42, true]) {
      ruf.mockResolvedValueOnce(antwort as never)
      await expect(findOrphanDownloads([])).resolves.toEqual([])
    }
  })

  it('ein Fehler der Gegenstelle ebenfalls', async () => {
    ruf.mockRejectedValueOnce(new Error('bridge is down'))
    await expect(findOrphanDownloads([])).resolves.toEqual([])
  })

  it('eine echte Liste kommt unveraendert durch', async () => {
    // Negativkontrolle: der Waechter darf nicht einfach alles verschlucken.
    const echt = [{ stem: 'pony', path: '/models/pony.safetensors.download', bytes: 17 }]
    ruf.mockResolvedValueOnce(echt as never)
    await expect(findOrphanDownloads([])).resolves.toEqual(echt)
  })

  it('und die Verzeichnisliste erreicht die Gegenstelle', async () => {
    // Sonst koennte der Waechter oben gruen sein, waehrend die Suche gar nicht
    // mehr dort sucht, wo die Dateien liegen.
    ruf.mockResolvedValueOnce([] as never)
    await findOrphanDownloads(['/models/lmstudio'])
    expect(ruf).toHaveBeenCalledWith('find_orphan_downloads', { extraDirs: ['/models/lmstudio'] })
  })
})
