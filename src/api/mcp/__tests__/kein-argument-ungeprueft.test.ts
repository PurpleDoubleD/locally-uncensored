/**
 * KF-18 — die Quelle der Anfrage prueft ihre eigenen Argumente.
 *
 * ── WAS PASSIERT IST ───────────────────────────────────────────────────────
 * `executeFileWrite` reichte `args.path` UNGEPRUEFT an `backendCall('fs_write')`
 * weiter. Liess das Modell das Feld weg, war es `undefined` und fiel bei
 * `JSON.stringify` aus dem Koerper — die Bridge bekam eine Schreibanfrage, die
 * ihr Ziel nie genannt hatte. Live hat genau diese Anfrage einmal
 * `~/agent-workspace-experiment/default` angelegt: 0 Bytes, und als DATEI da,
 * wo die WURZEL des Arbeitsverzeichnisses hingehoert.
 *
 * Dev-Server (KF-12) und gepackter Bau (KF-15) weisen sie seitdem ab. Das sind
 * die zweite und die dritte Ebene. Diese Reihe haelt die ERSTE fest: die Stelle,
 * an der die Anfrage entsteht.
 *
 * ── WARUM DIE TABELLE UND NICHT DREI HANDGESCHRIEBENE FAELLE ───────────────
 * Der Befund heisst nicht "eine Zeile", er heisst "die Argumente werden nicht
 * geprueft" — und `file_write` war nicht das einzige Werkzeug ohne Pruefung.
 * `PFLICHT` listet jede Pflichtangabe vom Typ string, die der Katalog selbst
 * deklariert; ein eigener Test vergleicht die Tabelle GEGEN den Katalog, damit
 * ein neu hinzugefuegtes Werkzeug mit ungeprueftem Pflichtargument hier
 * auffliegt statt still durchzurutschen.
 *
 * Gemessen wird nicht der Wortlaut der Absage, sondern DASS NICHTS HINAUSGEHT:
 * eine Wache, die nur den Text prueft, waere auch dann gruen, wenn die Anfrage
 * trotzdem abgeschickt wuerde.
 *
 * Run: npx vitest run src/api/mcp/__tests__/kein-argument-ungeprueft.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const backendCalls: { cmd: string; body: Record<string, unknown> }[] = []

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: Record<string, unknown>) => {
    backendCalls.push({ cmd, body })
    if (cmd === 'fs_read') return { content: 'alt', encoding: 'utf8' }
    if (cmd === 'fs_write') return { status: 'saved', path: '/w/a.ts', bytes: 3 }
    if (cmd === 'fs_list') return { entries: [], count: 0 }
    if (cmd === 'fs_search') return { results: [] }
    if (cmd === 'web_search') return { results: [{ title: 't', url: 'u', snippet: 's' }] }
    if (cmd === 'web_fetch') return { title: 't', url: 'u', status: 200, text: 'text' }
    if (cmd === 'shell_execute') return { stdout: '', stderr: '', exitCode: 0 }
    if (cmd === 'shell_task_start') return { id: 'task-1' }
    if (cmd === 'execute_code') return { stdout: '', stderr: '', exitCode: 0 }
    return { ok: true }
  }),
  fetchExternal: vi.fn(async () => '<html></html>'),
}))
// Delegation und Workflow-Maschine ziehen den ganzen Anbieter-Stapel herein,
// den keine der Pruefungen hier anfasst.
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { registerBuiltinTools, runRetiredTool } from '../builtin-tools'
import { ToolRegistry } from '../tool-registry'
import { setChatArtifactMode, takeChatArtifacts } from '../../agent-context'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

/** Jede Pflichtangabe vom Typ string, mit einem Wert, der durchginge. */
const PFLICHT: Record<string, Record<string, string>> = {
  web_search: { query: 'lu experiment' },
  web_fetch: { url: 'https://example.com/a' },
  file_read: { path: 'a.ts' },
  file_write: { path: 'a.ts', content: 'neu' },
  file_edit: { path: 'a.ts', old_string: 'alt', new_string: 'neu' },
  file_list: { path: '.' },
  file_search: { path: '.', pattern: 'alt' },
  pr_resume: { url: 'https://github.com/o/r/pull/1' },
  image_generate: { prompt: 'ein hund' },
  run_workflow: { name: 'Research Topic' },
}

/**
 * Der Bridge-Befehl, den eine unvollstaendige Anfrage NICHT erreichen darf.
 * Fehlt ein Werkzeug hier, muss der Aufruf ueberhaupt kein Backend beruehren.
 */
const GEHT_AN: Record<string, string> = {
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  file_read: 'fs_read',
  file_write: 'fs_write',
  file_edit: 'fs_write',
  file_list: 'fs_list',
  file_search: 'fs_search',
  pr_resume: 'shell_execute',
}

const befehle = () => backendCalls.map((c) => c.cmd)

beforeEach(() => {
  backendCalls.length = 0
  setChatArtifactMode(false)
})
afterEach(() => {
  setChatArtifactMode(false)
  takeChatArtifacts()
})

describe('die Tabelle deckt den Katalog ab', () => {
  it('jede Pflicht-Zeichenkette eines eingebauten Werkzeugs steht in PFLICHT', () => {
    for (const tool of registry.getAll()) {
      const nurStrings = (tool.inputSchema?.required ?? []).filter(
        (key) => tool.inputSchema?.properties?.[key]?.type === 'string',
      )
      expect(Object.keys(PFLICHT[tool.name] ?? {}).sort(), tool.name).toEqual([...nurStrings].sort())
    }
  })
})

describe('eine Anfrage ohne ihre Pflichtangabe geht gar nicht erst hinaus', () => {
  for (const [tool, voll] of Object.entries(PFLICHT)) {
    for (const fehlt of Object.keys(voll)) {
      it(`${tool} ohne \`${fehlt}\``, async () => {
        const args: Record<string, unknown> = { ...voll }
        delete args[fehlt]
        const out = await registry.execute(tool, args)
        // Der Text muss dem Modell sagen, WAS fehlt — sonst kann es sich nicht
        // korrigieren und wiederholt denselben Aufruf.
        expect(out.toLowerCase(), out).toContain(fehlt.toLowerCase())
        const verboten = GEHT_AN[tool]
        if (verboten) expect(befehle(), out).not.toContain(verboten)
        else expect(backendCalls, out).toEqual([])
      })

      // Nur fuer die Werkzeuge mit beobachtbarer Bridge: bei den anderen
      // (image_generate, run_workflow) laeuft der Aufruf in Stellen, die diese
      // Reihe nicht abhoert — ein gruener Balken bewiese dort nichts.
      const verbotenerBefehl = GEHT_AN[tool]
      if (!verbotenerBefehl) continue
      it(`${tool} mit einer Zahl statt \`${fehlt}\``, async () => {
        // `inputSchema` ist ein Hinweis in einem Prompt, kein Vertrag: ein
        // `path: 42` kommt genauso an wie ein fehlendes Feld.
        const out = await registry.execute(tool, { ...voll, [fehlt]: 42 })
        expect(befehle(), out).not.toContain(verbotenerBefehl)
      })
    }
  }
})

describe('der Vorfall selbst', () => {
  it('file_write ohne `path` schickt KEIN fs_write los', async () => {
    const out = await registry.execute('file_write', { content: 'irgendwas' })
    expect(befehle()).not.toContain('fs_write')
    expect(out).toContain('file_write')
    expect(out).toContain('path')
  })

  it('file_write ohne `path` erfindet auch im Chat-Artefakt-Modus keinen Namen', async () => {
    // Dort landete der namenlose Schreibvorgang vorher als "file.txt".
    setChatArtifactMode(true)
    const out = await registry.execute('file_write', { content: 'irgendwas' })
    expect(out).toContain('path')
    expect(takeChatArtifacts()).toEqual([])
  })

  it('file_write ohne `content` schreibt keine 0-Byte-Datei', async () => {
    const out = await registry.execute('file_write', { path: 'a.ts' })
    expect(befehle()).not.toContain('fs_write')
    expect(out).toContain('content')
  })
})

describe('die Pruefung sperrt nicht aus, was gemeint sein kann', () => {
  it('der vollstaendige file_write geht durch', async () => {
    const out = await registry.execute('file_write', { path: 'a.ts', content: 'neu' })
    expect(befehle()).toContain('fs_write')
    expect(out).toContain('File saved')
  })

  it('content: "" ist eine ABSICHTLICH leere Datei und wird geschrieben', async () => {
    // Das ist der Unterschied, den die Pruefung machen muss: '' heisst bei
    // `content` etwas anderes als bei `path`.
    await registry.execute('file_write', { path: 'leer.txt', content: '' })
    const call = backendCalls.find((c) => c.cmd === 'fs_write')
    expect(call?.body.content).toBe('')
    expect(call?.body.path).toBe('leer.txt')
  })

  it('new_string: "" loescht weiterhin Text', async () => {
    await registry.execute('file_edit', { path: 'a.ts', old_string: 'alt', new_string: '' })
    const call = backendCalls.find((c) => c.cmd === 'fs_write')
    expect(call?.body.content).toBe('')
  })

  it('file_read, file_list, file_search und web_search erreichen ihre Bridge', async () => {
    await registry.execute('file_read', { path: 'a.ts' })
    await registry.execute('file_list', { path: '.' })
    await registry.execute('file_search', { path: '.', pattern: 'alt' })
    await registry.execute('web_search', { query: 'lu' })
    expect(befehle()).toEqual(expect.arrayContaining(['fs_read', 'fs_list', 'fs_search', 'web_search']))
  })

  it('der gepruefte Pfad geht als Zeichenkette hinaus, nicht als args.path', async () => {
    await registry.execute('file_read', { path: 'a.ts' })
    expect(backendCalls.find((c) => c.cmd === 'fs_read')?.body.path).toBe('a.ts')
  })
})

describe('die zurueckgezogenen Namen pruefen genauso', () => {
  // Sie laufen ueber runRetiredTool DIREKT in ihren Executor und sehen die
  // Pruefungen von executeShellExecute nie.
  it('code_execute ohne `code`', async () => {
    const out = await runRetiredTool('code_execute', {})
    expect(out).toContain('code_execute: `code` is required')
    expect(befehle()).not.toContain('execute_code')
  })

  it('shell_execute_background ohne `command`', async () => {
    const out = await runRetiredTool('shell_execute_background', {})
    expect(out).toContain('`command` is required')
    expect(befehle()).not.toContain('shell_task_start')
  })

  it('shell_task_status ohne task_id', async () => {
    const out = await runRetiredTool('shell_task_status', {})
    expect(out).toContain('needs a task_id')
    expect(backendCalls).toEqual([])
  })

  it('shell_task_kill ohne task_id', async () => {
    const out = await runRetiredTool('shell_task_kill', {})
    expect(out).toContain('needs a task_id')
    expect(backendCalls).toEqual([])
  })

  it('mit ihren Argumenten laufen sie weiterhin', async () => {
    await runRetiredTool('code_execute', { code: 'print(1)' })
    expect(befehle()).toContain('execute_code')
  })
})
