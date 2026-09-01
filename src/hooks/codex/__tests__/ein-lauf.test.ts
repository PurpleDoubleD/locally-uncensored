/**
 * Was einen Codex-Lauf rahmt: Ordner, Absagen, Bloecke, Ergebnisanzeige und
 * die versteckte Kette fuer den naechsten Zug.
 *
 * ── WARUM ES DIESE TESTS VORHER NICHT GAB ──────────────────────────────────
 * Fuenf Regeln, fuenf Stellen quer durch `useCodex.ts`, keine davon von aussen
 * erreichbar. Die teuerste davon steht ganz oben: die Ordner-Rangfolge. Sie
 * bestimmt ZWEI Dinge gleichzeitig — was dem Modell als Arbeitsverzeichnis
 * GESAGT wird und worauf die Sperre GESETZT wird —, und genau diese beiden sind
 * am 2026-07-11 live auseinandergelaufen: die Sperre blieb auf der Sandbox,
 * waehrend das Modell einen echten Ordner genannt bekam, und jedes
 * `file_list`/`file_read` scheiterte mit "path escapes the allowed workspace".
 *
 * ── WAS HIER ECHT IST ──────────────────────────────────────────────────────
 * Echt: `useChatStore` fuer die Blockliste, `computeUnifiedDiff` und
 * `applyUniqueEdit` fuer die Unterschiede, `CODEX_MODE_LABELS` fuer die
 * Absagen. Nichts auf dem Weg unter Test ist ersetzt.
 *
 * Run: npx vitest run src/hooks/codex/__tests__/ein-lauf.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { resolveCodexWorkspace } from '../workspace-precedence'
import { codexModeRefusal } from '../mode-refusal'
import { createAgentBlockSink } from '../agent-blocks'
import { codexToolDiff, codexEventKind } from '../tool-result-view'
import { capHiddenToolHistory, HIDDEN_HISTORY_MAX } from '../hidden-history'
import { codexReadCtx } from '../workspace-fs'
import { useChatStore } from '../../../stores/chatStore'
import type { AgentWorkspace } from '../../../types/agent-workspace'
import type { ChatMessage } from '../../../api/providers/types'

// ── Ein Ordner, vier Bewerber ───────────────────────────────────────────────

const FOLDER: AgentWorkspace = { kind: 'folder', path: '/ws/aus-settings' }
const SANDBOX: AgentWorkspace = { kind: 'sandbox' }

describe('Welcher Ordner der Lauf benutzt', () => {
  it('die Auswahl im Datei-Baum schlaegt alles andere', () => {
    const r = resolveCodexWorkspace({
      threadWorkingDirectory: '/ws/aus-baum',
      codexWorkspace: FOLDER,
      storeWorkingDirectory: '/ws/global',
    })
    expect(r.workDir).toBe('/ws/aus-baum')
  })

  it('ein "." im Baum zaehlt NICHT als Auswahl', () => {
    const r = resolveCodexWorkspace({
      threadWorkingDirectory: '.',
      codexWorkspace: FOLDER,
      storeWorkingDirectory: '/ws/global',
    })
    expect(r.workDir).toBe('/ws/aus-settings')
  })

  it('danach der aufgeloeste Workspace, danach der globale, danach die Sandbox', () => {
    expect(resolveCodexWorkspace({ threadWorkingDirectory: null, codexWorkspace: FOLDER, storeWorkingDirectory: '/ws/global' }).workDir)
      .toBe('/ws/aus-settings')
    expect(resolveCodexWorkspace({ threadWorkingDirectory: null, codexWorkspace: null, storeWorkingDirectory: '/ws/global' }).workDir)
      .toBe('/ws/global')
    expect(resolveCodexWorkspace({ threadWorkingDirectory: null, codexWorkspace: null, storeWorkingDirectory: null }).workDir)
      .toBe('.')
  })

  it('ein Sandbox-Workspace liefert keinen Pfad und wird uebersprungen', () => {
    const r = resolveCodexWorkspace({ threadWorkingDirectory: null, codexWorkspace: SANDBOX, storeWorkingDirectory: '/ws/global' })
    expect(r.workspacePath).toBeNull()
    expect(r.workDir).toBe('/ws/global')
  })

  it('DIE ZUSICHERUNG: die Sperre nennt denselben Ordner, den das Modell genannt bekommt', () => {
    // Das ist der Fund vom 2026-07-11. Der Fall, an dem er auffiel, steht
    // zuerst: die Auswahl des Code-Reiters, die `resolveWorkspace()` GAR NICHT
    // SIEHT.
    const faelle = [
      { threadWorkingDirectory: null, codexWorkspace: null, storeWorkingDirectory: '/ws/explorer-auswahl' },
      { threadWorkingDirectory: '/ws/aus-baum', codexWorkspace: null, storeWorkingDirectory: null },
      { threadWorkingDirectory: '/ws/aus-baum', codexWorkspace: FOLDER, storeWorkingDirectory: '/ws/global' },
      { threadWorkingDirectory: null, codexWorkspace: SANDBOX, storeWorkingDirectory: '/ws/explorer-auswahl' },
      { threadWorkingDirectory: null, codexWorkspace: FOLDER, storeWorkingDirectory: null },
    ]
    for (const f of faelle) {
      const r = resolveCodexWorkspace(f)
      expect(r.workDir).not.toBe('.')
      expect(r.runWorkspace).not.toBeNull()
      expect(r.runWorkspace!.kind).toBe('folder')
      expect(r.runWorkspace!.path).toBe(r.workDir)
    }
  })

  it('ohne echten Ordner bleibt die Sperre, was sie war — die Sandbox pro Chat', () => {
    expect(resolveCodexWorkspace({ threadWorkingDirectory: null, codexWorkspace: null, storeWorkingDirectory: null }).runWorkspace)
      .toBeNull()
    expect(resolveCodexWorkspace({ threadWorkingDirectory: null, codexWorkspace: SANDBOX, storeWorkingDirectory: null }).runWorkspace)
      .toBe(SANDBOX)
  })

  it('Zusatzpfade eines Mehr-Repo-Laufs ueberleben die Umheftung', () => {
    const multi: AgentWorkspace = { kind: 'folder', path: '/ws/a', extraPaths: ['/ws/b'] }
    const r = resolveCodexWorkspace({ threadWorkingDirectory: '/ws/aus-baum', codexWorkspace: multi, storeWorkingDirectory: null })
    expect(r.runWorkspace!.path).toBe('/ws/aus-baum')
    expect(r.runWorkspace!.extraPaths).toEqual(['/ws/b'])
  })
})

// ── Der Lesekontext ─────────────────────────────────────────────────────────

describe('Der Lesekontext fuer fs_read', () => {
  it('nennt im Ordner-Betrieb die Wurzel, sonst nicht', () => {
    expect(codexReadCtx('slug', '/repo')).toEqual({ chatId: 'slug', workingDirectory: '/repo' })
    expect(codexReadCtx('slug', '.')).toEqual({ chatId: 'slug' })
    expect(codexReadCtx('slug', '')).toEqual({ chatId: 'slug' })
  })
})

// ── Absagen ─────────────────────────────────────────────────────────────────

const schreibbefehl = { command: { name: 'commit' } }
const lesebefehl = { command: { name: 'review', readOnly: true } }

describe('Ein Befehl, der in diesem Modus nichts ausrichten kann', () => {
  it('sagt im Review-Modus ab und nennt den Ausweg', () => {
    const m = codexModeRefusal({ reviewMode: true, codexMode: 'ask', slash: schreibbefehl })
    expect(m).toContain('Review Mode is on')
    expect(m).toContain('/commit')
    expect(m).toContain('/review, /plan, /diff or /explain')
  })

  it('sagt im Plan-Modus ab und nennt den Modus, auf den man stellen muss', () => {
    const m = codexModeRefusal({ reviewMode: false, codexMode: 'plan', slash: schreibbefehl })
    expect(m).toContain('Plan mode is read-only')
    expect(m).toContain('Ask permissions')
    expect(m).toContain('/review, /plan, /diff or /explain')
  })

  it('DIE RANGFOLGE: Review gewinnt vor Plan', () => {
    // Bisher ergab sich das nur daraus, dass ein `if` vor dem anderen stand.
    const m = codexModeRefusal({ reviewMode: true, codexMode: 'plan', slash: schreibbefehl })
    expect(m).toContain('Review Mode is on')
    expect(m).not.toContain('Plan mode is read-only')
  })

  it('laesst einen schreibfreien Befehl in beiden Modi durch', () => {
    expect(codexModeRefusal({ reviewMode: true, codexMode: 'plan', slash: lesebefehl })).toBeNull()
  })

  it('laesst eine normale Anweisung ohne Befehl immer durch', () => {
    expect(codexModeRefusal({ reviewMode: true, codexMode: 'plan', slash: null })).toBeNull()
  })

  it('behandelt ein fehlendes Review-Flag wie "aus"', () => {
    expect(codexModeRefusal({ reviewMode: undefined, codexMode: 'ask', slash: schreibbefehl })).toBeNull()
  })
})

// ── Die Blockliste ──────────────────────────────────────────────────────────

describe('Die Blockliste und ihr Spiegel im Speicher', () => {
  let convId = ''
  const MSG = 'msg-blocks'
  const gespiegelt = () =>
    useChatStore.getState().conversations.find((c) => c.id === convId)
      ?.messages.find((m) => m.id === MSG)?.agentBlocks

  beforeEach(() => {
    useChatStore.setState({ conversations: [], activeConversationId: null })
    convId = useChatStore.getState().createConversation('m', '', 'codex')
    useChatStore.getState().addMessage(convId, { id: MSG, role: 'assistant', content: '', timestamp: Date.now() })
  })

  it('jeder Zugang landet sofort im Speicher', () => {
    const sink = createAgentBlockSink(convId, MSG)
    sink.add({ id: 'b1', phase: 'answer', content: 'eins', timestamp: 1 })
    sink.add({ id: 'b2', phase: 'answer', content: 'zwei', timestamp: 2 })
    expect(gespiegelt()?.map((b) => b.id)).toEqual(['b1', 'b2'])
  })

  it('DIE ZUSICHERUNG: jeder Schreibvorgang reicht eine FRISCHE Liste weiter', () => {
    // React vergleicht flach. Zweimal dieselbe Liste hiesse: neue Bloecke sind
    // da, aber unsichtbar.
    const sink = createAgentBlockSink(convId, MSG)
    sink.add({ id: 'b1', phase: 'answer', content: 'eins', timestamp: 1 })
    const ersteListe = gespiegelt()
    sink.add({ id: 'b2', phase: 'answer', content: 'zwei', timestamp: 2 })
    expect(gespiegelt()).not.toBe(ersteListe)
    expect(gespiegelt()).not.toBe(sink.list())
  })

  it('update aendert genau einen Block und laesst den Rest stehen', () => {
    const sink = createAgentBlockSink(convId, MSG)
    sink.add({ id: 'b1', phase: 'tool_call', content: 'Running: file_read', timestamp: 1 })
    sink.add({ id: 'b2', phase: 'tool_call', content: 'Running: file_write', timestamp: 2 })
    sink.update('b1', { content: 'Completed: file_read' })
    expect(gespiegelt()?.map((b) => b.content)).toEqual(['Completed: file_read', 'Running: file_write'])
  })

  it('update auf eine unbekannte Kennung tut NICHTS — kein Nachschieben, kein Anlegen', () => {
    const sink = createAgentBlockSink(convId, MSG)
    sink.add({ id: 'b1', phase: 'answer', content: 'eins', timestamp: 1 })
    const vorher = gespiegelt()
    sink.update('gibtesnicht', { content: 'kaputt' })
    expect(gespiegelt()).toBe(vorher)
    expect(gespiegelt()).toHaveLength(1)
  })
})

// ── Was der Nutzer vom Ergebnis sieht ───────────────────────────────────────

describe('Der nachgebaute Unterschied eines fertigen Aufrufs', () => {
  it('file_write: Vorlese-Runde gegen den geschriebenen Inhalt', () => {
    const d = codexToolDiff({ toolName: 'file_write', path: 'a.ts', oldText: 'alt\n', args: { content: 'neu\n' } })
    expect(d).toContain('-alt')
    expect(d).toContain('+neu')
  })

  it('file_edit: der neue Inhalt wird aus Vorgelesenem plus Ersetzung rekonstruiert', () => {
    const d = codexToolDiff({
      toolName: 'file_edit', path: 'a.ts', oldText: 'eins\nzwei\ndrei\n',
      args: { old_string: 'zwei', new_string: 'ZWEI' },
    })
    expect(d).toContain('-zwei')
    expect(d).toContain('+ZWEI')
    // Die unberuehrten Zeilen bleiben Kontext, keine Loeschung.
    expect(d).not.toContain('-eins')
  })

  it('eine nicht eindeutige Bearbeitung zeigt GAR KEINEN Unterschied statt einen falschen', () => {
    const d = codexToolDiff({
      toolName: 'file_edit', path: 'a.ts', oldText: 'x\nx\n',
      args: { old_string: 'x', new_string: 'y' },
    })
    expect(d).toBeUndefined()
  })

  it('ein Aufruf, der nichts geaendert hat, bekommt keinen leeren Rahmen', () => {
    expect(codexToolDiff({ toolName: 'file_write', path: 'a.ts', oldText: 'gleich\n', args: { content: 'gleich\n' } }))
      .toBeUndefined()
  })

  it('Argumente, die das Modell nicht als Text geschickt hat, werden nicht geraten', () => {
    // `content` ist Modell-Ausgabe. Eine Zahl darf nicht als "123" gezeichnet
    // werden, sondern zaehlt als leer.
    const d = codexToolDiff({ toolName: 'file_write', path: 'a.ts', oldText: 'alt\n', args: { content: 123 } })
    expect(d).toContain('-alt')
    expect(d).not.toContain('123')
  })

  it('jedes andere Werkzeug bekommt keinen Unterschied', () => {
    expect(codexToolDiff({ toolName: 'shell_execute', path: undefined, oldText: '', args: { command: 'ls' } }))
      .toBeUndefined()
  })
})

describe('In welchen Eintrag des Ereignisprotokolls ein Aufruf faellt', () => {
  it('die beiden Ausfuehrer werden Terminalausgabe', () => {
    expect(codexEventKind('shell_execute', false)).toBe('terminal_output')
    expect(codexEventKind('code_execute', false)).toBe('terminal_output')
  })

  it('DIE REIHENFOLGE: ein FEHLGESCHLAGENES file_write bleibt eine Dateiaenderung', () => {
    // Der Zweig fuer die Schreibwerkzeuge steht vor dem Fehlerzweig. Wer das
    // umdreht, verliert die Aenderungsansicht genau dann, wenn man sie braucht.
    expect(codexEventKind('file_write', true)).toBe('file_change')
    expect(codexEventKind('file_edit', true)).toBe('file_change')
    expect(codexEventKind('shell_execute', true)).toBe('terminal_output')
  })

  it('ein gescheitertes Lesewerkzeug wird ein Fehler', () => {
    expect(codexEventKind('file_read', true)).toBe('error')
  })

  it('ein gelungenes Lesewerkzeug bekommt gar keinen Eintrag', () => {
    expect(codexEventKind('file_read', false)).toBeNull()
    expect(codexEventKind('web_search', false)).toBeNull()
  })
})

// ── Die versteckte Werkzeugkette ────────────────────────────────────────────

const paar = (i: number): ChatMessage[] => ([
  { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'file_read', arguments: {} } }] },
  { role: 'tool', content: `ergebnis ${i}`, tool_call_id: `c${i}` },
])

describe('Was der naechste Zug an versteckter Kette wiederbekommt', () => {
  it('kurze Ketten bleiben unangetastet', () => {
    const all = [...paar(1), ...paar(2)]
    expect(capHiddenToolHistory(all)).toEqual(all)
  })

  it('lange Ketten werden gedeckelt', () => {
    const all = Array.from({ length: 100 }, (_, i) => paar(i)).flat()
    expect(capHiddenToolHistory(all).length).toBeLessThanOrEqual(HIDDEN_HISTORY_MAX)
  })

  it('DIE ZUSICHERUNG: die behaltene Kette beginnt NIE mit einem Waisen-Ergebnis', () => {
    // Ein Ergebnis, dessen Aufruf aus dem Fenster fiel, laesst einen strengen
    // Anbieter den ganzen Folgezug mit 422 abweisen.
    //
    // DIE PAARIGE KETTE ALLEIN ZEIGT DAS NICHT: bei lauter Aufruf/Ergebnis-Paaren
    // faellt die Fenstergrenze immer auf einen geraden Index, also auf einen
    // Aufruf. Der Waisenfall entsteht erst, wenn die Kette UNGERADE lang ist —
    // und genau so endet ein echter Lauf, dessen letzter Zug nur noch geredet
    // hat. Beide Formen stehen deshalb hier, sonst waere die Zusicherung leer.
    const schluss: ChatMessage = { role: 'assistant', content: 'fertig' }
    for (const n of [30, 31, 60, 61, 120, 121]) {
      const paare = Array.from({ length: n }, (_, i) => paar(i)).flat()
      for (const all of [paare, [...paare, schluss]]) {
        const kept = capHiddenToolHistory(all)
        if (kept.length > 0) expect(kept[0].role).not.toBe('tool')
      }
      // Und derselbe Grenzfall ueber eine ungerade Fensterbreite.
      const eng = capHiddenToolHistory(paare, 59)
      if (eng.length > 0) expect(eng[0].role).not.toBe('tool')
    }
  })

  it('der Waisenschnitt kostet genau die eine Waise, nicht mehr', () => {
    const paare = Array.from({ length: 50 }, (_, i) => paar(i)).flat()
    const eng = capHiddenToolHistory(paare, 59)
    // 59 gedeckelt, die fuehrende Waise weg: 58 bleiben, und der Rest steht
    // vollstaendig da.
    expect(eng).toHaveLength(58)
    expect(eng[0].role).toBe('assistant')
    expect(eng[eng.length - 1].role).toBe('tool')
  })

  it('ein Fenster aus lauter Ergebnissen bleibt leer statt kaputt', () => {
    const nurErgebnisse: ChatMessage[] = Array.from({ length: 5 }, (_, i) => ({
      role: 'tool', content: `e${i}`, tool_call_id: `c${i}`,
    }))
    expect(capHiddenToolHistory(nurErgebnisse)).toEqual([])
  })

  it('eine leere Kette bleibt leer', () => {
    expect(capHiddenToolHistory([])).toEqual([])
  })
})
