/**
 * Die eine harte Sperre des Terminal-Tools gilt dem KOMMANDO, nicht der
 * Betriebsart.
 *
 * `rejectShellCommand` (--no-verify auf einem Commit) stand in
 * `executeShellExecute` UNTER der Hintergrund-Weiche: `if (args.background)
 * return executeShellExecuteBg(…)` kam zuerst, die Pruefung erst danach. Ein
 * Modell streifte die Sperre damit durch simples Anhaengen von
 * `background: true` ab — bestaetigt: der Vordergrund antwortete "Refused: git
 * commit --no-verify skips…", derselbe Aufruf mit `background: true` lieferte
 * "Task started: …" und setzte `shell_task_start` an der Bridge ab.
 *
 * Zweiter Eingang: der zurueckgezogene Name `shell_execute_background` laeuft
 * ueber `runRetiredTool` DIREKT in `executeShellExecuteBg` und sieht
 * `executeShellExecute` nie. Dieselbe Luecke, andere Tuer — deshalb sitzt die
 * Pruefung an BEIDEN Stellen.
 *
 * Run: npx vitest run src/api/mcp/__tests__/shell-bg-refusal-parity.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendCalls: { cmd: string; body: Record<string, unknown> }[] = []

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: Record<string, unknown>) => {
    backendCalls.push({ cmd, body })
    if (cmd === 'shell_execute') return { stdout: 'ran', stderr: '', exitCode: 0 }
    if (cmd === 'shell_task_start') return { id: 'task-1' }
    if (cmd === 'shell_task_kill') return { ok: true, cancelled: true }
    return { ok: true }
  }),
  fetchExternal: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
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

/** Was die Bridge zu sehen bekommen hat. Eine abgelehnte Sperre heisst: nichts. */
const started = () => backendCalls.filter((c) => c.cmd === 'shell_task_start')
const ran = () => backendCalls.filter((c) => c.cmd === 'shell_execute')

const NO_VERIFY = 'git commit --no-verify -m x'

beforeEach(() => { backendCalls.length = 0 })

describe('--no-verify wird in beiden Betriebsarten abgelehnt', () => {
  it('Vordergrund: abgelehnt, nichts laeuft (Ausgangszustand, unveraendert)', async () => {
    const out = await registry.execute('shell_execute', { command: NO_VERIFY })
    expect(out).toMatch(/^Refused: git commit --no-verify/)
    expect(ran()).toHaveLength(0)
  })

  it('MUTATIONSSONDE: `background: true` streift die Sperre NICHT mehr ab', async () => {
    const out = await registry.execute('shell_execute', { command: NO_VERIFY, background: true })
    expect(out).toMatch(/^Refused: git commit --no-verify/)
    // Der eigentliche Beweis: kein Task an der Bridge. Vor dem Fix stand hier
    // "Task started: task-1" und ein abgesetztes shell_task_start.
    expect(started()).toHaveLength(0)
    expect(backendCalls).toHaveLength(0)
  })

  it('Vordergrund und Hintergrund geben denselben Wortlaut zurueck', async () => {
    const fg = await registry.execute('shell_execute', { command: NO_VERIFY })
    const bg = await registry.execute('shell_execute', { command: NO_VERIFY, background: true })
    expect(bg).toBe(fg)
  })

  it('auch mit weiteren Argumenten daneben — die Sperre haengt am Kommando', async () => {
    const out = await registry.execute('shell_execute', {
      command: NO_VERIFY,
      cwd: '/repo',
      shell: 'bash',
      background: true,
    })
    expect(out).toMatch(/^Refused:/)
    expect(started()).toHaveLength(0)
  })

  it('zweiter Eingang: der zurueckgezogene Name shell_execute_background', async () => {
    // runRetiredTool ruft executeShellExecuteBg DIREKT — executeShellExecute und
    // damit dessen Pruefung liegen auf diesem Weg gar nicht dazwischen.
    const out = await registry.execute('shell_execute_background', { command: NO_VERIFY })
    expect(out).toMatch(/^Refused: git commit --no-verify/)
    expect(started()).toHaveLength(0)
  })

  it('fuehrender Leerraum und Zeilenumbruch sind kein Schlupfloch', async () => {
    // Ueber den Redirect kommt `command` UNGETRIMMT an. commandKind() trimmt
    // selbst, die Sperre greift also trotzdem — der Trim ist hier nicht die
    // Luecke, die Reihenfolge war es.
    for (const cmd of [`   ${NO_VERIFY}`, `\n\t ${NO_VERIFY}`]) {
      backendCalls.length = 0
      expect(await registry.execute('shell_execute_background', { command: cmd })).toMatch(/^Refused:/)
      expect(await registry.execute('shell_execute', { command: cmd, background: true })).toMatch(/^Refused:/)
      expect(started()).toHaveLength(0)
    }
  })

  it('NEGATIVKONTROLLE: ein harmloses Kommando laeuft im Hintergrund weiter', async () => {
    // Sonst waere die Sperre nur zu breit gezogen statt richtig platziert.
    const out = await registry.execute('shell_execute', { command: 'npm run build', background: true })
    expect(out).toContain('Task started: task-1')
    expect(started()).toHaveLength(1)
  })

  it('NEGATIVKONTROLLE: ein normaler Commit im Hintergrund laeuft weiter', async () => {
    const out = await registry.execute('shell_execute', {
      command: 'git commit -m "wip"',
      background: true,
    })
    expect(out).toContain('Task started: task-1')
    expect(started()).toHaveLength(1)
  })

  it('NEGATIVKONTROLLE: der Vordergrund fuehrt harmlose Kommandos weiter aus', async () => {
    const out = await registry.execute('shell_execute', { command: 'echo hi' })
    expect(out).toBe('ran')
    expect(ran()).toHaveLength(1)
  })

  it('die Pruefung steht im Quelltext VOR der Hintergrund-Weiche', () => {
    // Verhalten allein kann das nicht festnageln: der Guard in
    // executeShellExecuteBg faengt denselben Fall ab, beide Reihenfolgen sehen
    // von aussen identisch aus. Die Reihenfolge ist trotzdem die eigentliche
    // Korrektur — der Guard im Hintergrund-Executor ist die zweite Tuer, nicht
    // der Ersatz. Also wie in shell-honours-stop.test.ts am Quelltext gepinnt.
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../builtin-tools.ts'), 'utf8')
    const check = src.indexOf('const refusal = rejectShellCommand(command)')
    const branch = src.indexOf('if (args.background) return executeShellExecuteBg(')
    expect(check).toBeGreaterThan(-1)
    expect(branch).toBeGreaterThan(-1)
    expect(check).toBeLessThan(branch)
  })
})
