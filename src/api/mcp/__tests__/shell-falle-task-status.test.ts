/**
 * Ein Aufruf, der alles dabei hat, um zu laufen, darf nicht am Beiwerk scheitern.
 *
 * Persona-Lauf vom 03.09.2026, `llama3.2:3b`. Auftrag: die macOS-Version ueber
 * `shell_execute` herausfinden. Das Modell schickte in 3 von 3 Anlaeufen:
 *
 *   {"cwd":".","shell":"bash","task":"status",
 *    "command":"sw_vers -productVersion","timeout":600000}
 *
 * Antwort des Werkzeugs: `shell_execute: task "status" needs a task_id.` — der
 * Befehl lief nie. Danach nannte der Assistent `10.15` als Ausgabe. Der
 * wirkliche Wert war `26.3.1`: frei erfunden und als Befehlsausgabe verkauft.
 *
 * `task` waehlt eine Nebenhandlung (list/status/kill) an einem HINTERGRUND-Lauf
 * aus. Kleine Modelle fuellen das Feld wie jedes andere Schema-Feld mit — und
 * `status` ohne `task_id` ist ein garantierter Fehlschlag, waehrend daneben ein
 * vollstaendiger Befehl steht. Diese Kombination hat genau eine sinnvolle
 * Lesart, und die fuehrt das Werkzeug jetzt aus.
 *
 * Was NICHT gelockert wird: mit `task_id` bleibt `status`/`kill` die Abfrage
 * am Hintergrundlauf, und ohne Befehl bleibt der Fehlschlag ein Fehlschlag.
 *
 * Run: npx vitest run src/api/mcp/__tests__/shell-falle-task-status.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCalls: { cmd: string; body: Record<string, unknown> }[] = []

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: Record<string, unknown>) => {
    backendCalls.push({ cmd, body })
    if (cmd === 'shell_execute') return { stdout: '26.3.1\n', stderr: '', exitCode: 0 }
    if (cmd === 'shell_task_status') return { id: 't-1', state: 'running', output: '' }
    if (cmd === 'shell_task_kill') return { id: 't-1', state: 'killed' }
    return { ok: true }
  }),
  fetchExternal: vi.fn(async () => ''),
}))
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { registerBuiltinTools } from '../builtin-tools'
import { ToolRegistry } from '../tool-registry'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

const shell = (args: Record<string, unknown>) => registry.execute('shell_execute', args)

beforeEach(() => { backendCalls.length = 0 })

describe('shell_execute: task neben einem fertigen Befehl', () => {
  it('fuehrt den Befehl der Persona aus, statt am task_id zu scheitern', async () => {
    const out = await shell({
      cwd: '.', shell: 'bash', task: 'status',
      command: 'sw_vers -productVersion', timeout: 600000,
    })
    expect(out).toContain('26.3.1')
    expect(out).not.toContain('needs a task_id')
    // Der Punkt ist nicht der Wortlaut, sondern dass wirklich etwas lief.
    expect(backendCalls.map((c) => c.cmd)).toContain('shell_execute')
    expect(backendCalls.find((c) => c.cmd === 'shell_execute')?.body.command)
      .toBe('sw_vers -productVersion')
  })

  it('dasselbe fuer kill', async () => {
    const out = await shell({ task: 'kill', command: 'echo hallo' })
    expect(out).not.toContain('needs a task_id')
    expect(backendCalls.map((c) => c.cmd)).toContain('shell_execute')
  })

  it('mit task_id bleibt es die Abfrage am Hintergrundlauf', async () => {
    // Sonst haette die Lockerung die eigentliche Funktion aufgefressen.
    await shell({ task: 'status', task_id: 't-1', command: 'echo hallo' })
    expect(backendCalls.map((c) => c.cmd)).toContain('shell_task_status')
    expect(backendCalls.map((c) => c.cmd)).not.toContain('shell_execute')
  })

  it('ohne Befehl bleibt der Fehlschlag ein Fehlschlag', async () => {
    const out = await shell({ task: 'status' })
    expect(out).toContain('task_id')
    expect(backendCalls).toEqual([])
  })

  it('ein leerer Befehl zaehlt nicht als Befehl', async () => {
    const out = await shell({ task: 'status', command: '   ' })
    expect(out).toContain('task_id')
    expect(backendCalls).toEqual([])
  })
})
