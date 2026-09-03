/**
 * Die Ablage-Warteschlange des Coding-Agenten (Stage-and-Approve).
 *
 * ── WARUM ES DIESEN TEST VORHER NICHT GAB ──────────────────────────────────
 * `stageFileWrite` und `stageFileEdit` waren zwei Closures 1900 Zeilen tief in
 * einem 2358-Zeilen-`useCallback` eines React-Hooks. Sie schlossen ueber
 * `convId`, `workDir`, `workspaceSlug` und `backendCall` und waren von aussen
 * nicht erreichbar — man konnte sie nur pruefen, indem man einen ganzen
 * Codex-Zug fuhr, also mit Modell, Anbieter und Rust-Backend daran. Genau
 * deshalb hing an diesen 150 Zeilen kein einziger Test, obwohl in ihnen die
 * Lies-deine-Schreibungen-Regel steckt, deren Fehlen Morgan am 2026-07-26 eine
 * fuenfminuetige `file_read`-Schleife eingebracht hat.
 *
 * ── WAS HIER ECHT IST ──────────────────────────────────────────────────────
 * Echt: `useStagedChangesStore` (der wirkliche Zustandsspeicher),
 * `computeUnifiedDiff`, `applyUniqueEdit`, `findStagedForPath`,
 * `stagedReadResult`, `stagedListingNote` — die ganze Kette unter Test.
 *
 * Der Dateileser ist eine ECHTE Funktion ueber eine echte Zuordnung
 * Pfad→Inhalt, kein Attrappen-Rahmenwerk: das Modul nimmt ihn als Naht
 * entgegen, genau wie `dev-server/fs-routes.ts` dem Pfad-Kaefig seinen
 * `realPath` von aussen gibt. Was in der App dahintersteht, ist
 * `readWorkspaceFile` → `backendCall('fs_read')`; das ist ein Prozessaufruf ins
 * Rust-Backend und hat in einem node-Test nichts verloren.
 *
 * Run: npx vitest run src/hooks/codex/__tests__/ablage-warteschlange.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createStagedWriter } from '../staged-writes'
import { useStagedChangesStore } from '../../../stores/stagedChangesStore'
import type { CodexFsCtx, CodexFileRead } from '../workspace-fs'

const CONV = 'conv-ablage'

/** Ein echter Leser ueber eine echte Zuordnung. Fehlt der Pfad, wirft er — so
 *  wie `fs_read` es fuer eine nicht vorhandene Datei tut. */
function readerOver(files: Record<string, CodexFileRead>) {
  const seen: string[] = []
  const read = (path: string, _ctx: CodexFsCtx): Promise<CodexFileRead> => {
    seen.push(path)
    const hit = files[path]
    if (!hit) return Promise.reject(new Error(`ENOENT: ${path}`))
    return Promise.resolve(hit)
  }
  return { read, seen }
}

function writerIn(workDir: string, files: Record<string, CodexFileRead> = {}) {
  const r = readerOver(files)
  return {
    writer: createStagedWriter({
      convId: CONV,
      workDir,
      workspaceSlug: 'slug-1',
      readFile: r.read,
    }),
    seen: r.seen,
  }
}

const queue = () => useStagedChangesStore.getState().list(CONV)

beforeEach(() => {
  useStagedChangesStore.getState().clear(CONV)
})

describe('Der Pfad, unter dem eine Aenderung spaeter landet', () => {
  it('haengt einen relativen Pfad an den Arbeitsordner', async () => {
    const { writer } = writerIn('/home/u/repo')
    await writer.stageFileWrite({ path: 'src/app.ts', content: 'neu' })
    expect(queue()[0].resolvedPath).toBe('/home/u/repo/src/app.ts')
  })

  it('nimmt den Windows-Trenner, wenn der Arbeitsordner einer ist', async () => {
    const { writer } = writerIn('D:\\Pictures\\foo')
    await writer.stageFileWrite({ path: 'index.html', content: 'x' })
    expect(queue()[0].resolvedPath).toBe('D:\\Pictures\\foo\\index.html')
  })

  it('laesst absolute Pfade in Ruhe — unix, Laufwerksbuchstabe und UNC', async () => {
    for (const [i, p] of ['/etc/hosts', 'C:/Windows/x.dll', '\\\\server\\share\\x.txt'].entries()) {
      useStagedChangesStore.getState().clear(CONV)
      const { writer } = writerIn('/home/u/repo')
      await writer.stageFileWrite({ path: p, content: `v${i}` })
      expect(queue()[0].resolvedPath).toBe(p)
    }
  })

  it('laesst in der Sandbox alles unveraendert und merkt sich KEINE Wurzel', async () => {
    const { writer } = writerIn('.')
    await writer.stageFileWrite({ path: 'a.txt', content: 'x' })
    expect(queue()[0].resolvedPath).toBe('a.txt')
    // Ohne echten Ordner ist die Sandbox pro Chat die richtige Wurzel; ein
    // gemerktes '.' wuerde das Anwenden spaeter in den falschen Ordner lenken.
    expect(queue()[0].workingDirectory).toBeUndefined()
  })

  it('merkt sich im Ordner-Betrieb die Wurzel fuer das spaetere Anwenden', async () => {
    const { writer } = writerIn('/home/u/repo')
    await writer.stageFileWrite({ path: 'a.txt', content: 'x' })
    expect(queue()[0].workingDirectory).toBe('/home/u/repo')
  })
})

describe('Lies deine eigenen Schreibungen', () => {
  it('zweites file_write auf dieselbe Datei behaelt die PLATTENfassung als Vergleichsbasis', async () => {
    const { writer, seen } = writerIn('/repo', { '/repo/a.ts': { content: 'PLATTE' } })
    await writer.stageFileWrite({ path: 'a.ts', content: 'erste' })
    await writer.stageFileWrite({ path: 'a.ts', content: 'zweite' })
    expect(queue()).toHaveLength(1)
    expect(queue()[0].newContent).toBe('zweite')
    // Das ist die Zusicherung: der geprueft angezeigte Unterschied bleibt
    // Platte → Endstand, nicht abgelegt → abgelegt.
    expect(queue()[0].oldContent).toBe('PLATTE')
    // Und die Platte wird dafuer kein zweites Mal gelesen.
    expect(seen).toEqual(['/repo/a.ts'])
  })

  it('file_edit setzt auf dem ABGELEGTEN Inhalt auf, nicht auf der Platte', async () => {
    const { writer } = writerIn('/repo', { '/repo/a.ts': { content: 'eins zwei' } })
    await writer.stageFileEdit({ path: 'a.ts', old_string: 'eins', new_string: 'EINS' })
    const zweite = await writer.stageFileEdit({ path: 'a.ts', old_string: 'zwei', new_string: 'ZWEI' })
    expect(zweite).toContain('Staged for review')
    // Ohne die Regel haette die zweite Bearbeitung die erste still ueberschrieben.
    expect(queue()[0].newContent).toBe('EINS ZWEI')
    expect(queue()[0].oldContent).toBe('eins zwei')
  })

  it('file_edit an einer abgelegten NEUEN Datei gelingt, obwohl die Platte sie nicht kennt', async () => {
    const { writer } = writerIn('/repo')
    await writer.stageFileWrite({ path: 'neu.ts', content: 'hallo welt' })
    const res = await writer.stageFileEdit({ path: 'neu.ts', old_string: 'welt', new_string: 'du' })
    expect(res).toContain('Staged for review')
    expect(queue()[0].newContent).toBe('hallo du')
    expect(queue()[0].oldContent).toBe('')
  })

  it('file_read wird AUS der Schlange beantwortet, mit Merkzettel', async () => {
    const { writer } = writerIn('/repo', { '/repo/a.ts': { content: 'PLATTE' } })
    await writer.stageFileWrite({ path: 'a.ts', content: 'ABGELEGT' })
    const res = await writer.dispatch('file_read', { path: 'a.ts' }, () =>
      Promise.resolve('DAS DARF NICHT KOMMEN'))
    expect(res).toContain('ABGELEGT')
    expect(res).not.toContain('DAS DARF NICHT KOMMEN')
    expect(res).toContain('NOT on disk yet')
  })

  it('file_read auf einen NICHT abgelegten Pfad geht durch', async () => {
    const { writer } = writerIn('/repo')
    await writer.stageFileWrite({ path: 'a.ts', content: 'x' })
    const res = await writer.dispatch('file_read', { path: 'b.ts' }, () => Promise.resolve('VON DER PLATTE'))
    expect(res).toBe('VON DER PLATTE')
  })

  it('file_list und file_search bekommen die Anmerkung ANGEHAENGT, nicht ersetzt', async () => {
    const { writer } = writerIn('/repo')
    await writer.stageFileWrite({ path: 'a.ts', content: 'x' })
    for (const name of ['file_list', 'file_search']) {
      const res = await writer.dispatch(name, {}, () => Promise.resolve('ECHTES LISTING'))
      expect(res.startsWith('ECHTES LISTING')).toBe(true)
      expect(res).toContain('a.ts')
    }
  })

  it('ohne etwas in der Schlange bleibt jede Antwort unberuehrt', async () => {
    const { writer } = writerIn('/repo')
    for (const name of ['file_read', 'file_list', 'file_search', 'shell_execute']) {
      const res = await writer.dispatch(name, { path: 'a.ts' }, () => Promise.resolve('ROH'))
      expect(res).toBe('ROH')
    }
  })
})

describe('Was der Nutzer vor der Freigabe zu sehen bekommt', () => {
  it('eine neue Datei erscheint als reine Einfuegung', async () => {
    const { writer } = writerIn('/repo')
    await writer.stageFileWrite({ path: 'neu.ts', content: 'a\nb\n' })
    const d = queue()[0].diff
    expect(d).toContain('+a')
    expect(d).toContain('+b')
    // Der Kopf `--- a/neu.ts` zaehlt nicht; gemeint sind Loeschzeilen.
    expect(d.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))).toHaveLength(0)
  })

  it('eine UEBERSCHRIEBENE Datei zeigt die Loeschungen — das war der Fehler von 2.5.9', async () => {
    const { writer } = writerIn('/repo', { '/repo/a.ts': { content: 'alt1\nalt2\n' } })
    await writer.stageFileWrite({ path: 'a.ts', content: 'neu\n' })
    const d = queue()[0].diff
    expect(d).toContain('-alt1')
    expect(d).toContain('-alt2')
    expect(d).toContain('+neu')
  })
})

describe('Was schiefgehen kann, und was dann dasteht', () => {
  it('ohne Pfad sagt es das und legt nichts ab', async () => {
    const { writer } = writerIn('/repo')
    expect(await writer.stageFileWrite({})).toBe('file_write: missing path')
    expect(await writer.stageFileEdit({})).toBe('file_edit: missing path')
    expect(queue()).toHaveLength(0)
  })

  it('eine Binaerdatei wird nicht bearbeitet', async () => {
    for (const enc of ['binary', 'base64']) {
      useStagedChangesStore.getState().clear(CONV)
      const { writer } = writerIn('/repo', { '/repo/bild.png': { content: 'xx', encoding: enc } })
      const res = await writer.stageFileEdit({ path: 'bild.png', old_string: 'x', new_string: 'y' })
      expect(res).toBe('file_edit: cannot edit a binary file (bild.png).')
      expect(queue()).toHaveLength(0)
    }
  })

  it('eine unlesbare Datei verweist auf file_write statt still zu scheitern', async () => {
    const { writer } = writerIn('/repo')
    const res = await writer.stageFileEdit({ path: 'weg.ts', old_string: 'a', new_string: 'b' })
    expect(res).toBe('file_edit: could not read weg.ts. To create a new file use file_write.')
    expect(queue()).toHaveLength(0)
  })

  it('die vier Absagen des chirurgischen Schnitts kommen woertlich durch', async () => {
    const { writer } = writerIn('/repo', { '/repo/a.ts': { content: 'x x' } })
    expect(await writer.stageFileEdit({ path: 'a.ts', old_string: '', new_string: 'b' }))
      .toBe('file_edit: old_string must be non-empty. Use file_write to create a new file.')
    expect(await writer.stageFileEdit({ path: 'a.ts', old_string: 'x', new_string: 'x' }))
      .toBe('file_edit: old_string and new_string are identical, nothing to change.')
    expect(await writer.stageFileEdit({ path: 'a.ts', old_string: 'zzz', new_string: 'b' }))
      .toBe('file_edit: old_string not found in a.ts. Read the file and copy the exact text you want to replace.')
    expect(await writer.stageFileEdit({ path: 'a.ts', old_string: 'x', new_string: 'y' }))
      .toBe('file_edit: old_string matches 2 places in a.ts. Add surrounding lines so it is unique.')
    // Keine dieser vier Absagen darf etwas in die Schlange legen.
    expect(queue()).toHaveLength(0)
  })
})
