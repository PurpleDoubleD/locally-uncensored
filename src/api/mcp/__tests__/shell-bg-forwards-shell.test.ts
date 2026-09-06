/**
 * `shell_execute` bewirbt im Schema ein Feld `shell` ("powershell" | "cmd" |
 * "bash"). Der Vordergrundpfad reicht es an die Bridge durch, der
 * Hintergrundpfad hat es stillschweigend weggeworfen: `executeShellExecuteBg`
 * bekam nur `{ command, cwd }`, und `bgStart` — das `shell?: string` sehr wohl
 * kennt — sah nie einen Wert. Ein Modell, das
 * `{ command, shell: "bash", background: true }` schickt, lief damit ohne jede
 * Meldung in der Plattform-Default-Shell.
 *
 * Bis ba9557df waere das Durchreichen gefaehrlich gewesen: `shell_task_start_impl`
 * baute auf Windows immer PowerShells `-NoProfile -NonInteractive -Command`,
 * egal welche Shell benannt war — ein durchgereichtes `shell: "cmd"` waere in
 * die interaktive Eingabeaufforderung gelaufen. Seit ba9557df leitet
 * `shell::shell_argv` die Argumentform aus dem Shell-NAMEN ab, damit ist das
 * Durchreichen folgenlos richtig.
 *
 * Run: npx vitest run src/api/mcp/__tests__/shell-bg-forwards-shell.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

function bodyOf(cmd: string): Record<string, unknown> {
  const call = backendCalls.find((c) => c.cmd === cmd)
  expect(call, `kein ${cmd} am Backend angekommen`).toBeDefined()
  return call?.body ?? {}
}

/** Der `args`-Block, den `shell_task_start` von `bgStart` bekommt. */
function startArgs(): Record<string, unknown> {
  // Der Rust-Befehl nimmt einen EINZIGEN `args: Value` (StartArgs); ein flacher
  // Payload waere an der Bridge abgelehnt worden.
  const wrapped = bodyOf('shell_task_start').args
  expect(wrapped, 'shell_task_start ohne `args`-Wrapper').toBeTypeOf('object')
  return wrapped as Record<string, unknown>
}

/** Der flache Payload, den der Vordergrundpfad an `shell_execute` schickt. */
function execPayload(): Record<string, unknown> {
  return bodyOf('shell_execute')
}

beforeEach(() => { backendCalls.length = 0 })

describe('shell_execute: `shell` erreicht auch den Hintergrundpfad', () => {
  it('das Schema verspricht `shell` — genau deshalb muss es ankommen', () => {
    const props = registry.getToolByName('shell_execute')?.inputSchema.properties
    expect(props?.shell).toBeDefined()
    // Und `background` steht im selben Schema, ohne Einschraenkung auf `shell`.
    expect(props?.background).toBeDefined()
  })

  it('MUTATIONSSONDE: `shell: "bash"` + `background: true` kommt bis in bgStart an', async () => {
    await registry.execute('shell_execute', {
      command: 'npm run build',
      shell: 'bash',
      background: true,
    })
    // Die eine Zeile, die der Fix gerade macht. Nimmt man das Durchreichen an
    // einer der beiden Stellen (Dispatch in executeShellExecute oder bgStart-
    // Aufruf in executeShellExecuteBg) zurueck, faellt genau dieses expect um.
    expect(startArgs().shell).toBe('bash')
    expect(startArgs().command).toBe('npm run build')
  })

  it('"cmd" wird genauso durchgereicht — der Wert wird nicht auf eine Whitelist gefiltert', async () => {
    // Der Name entscheidet auf Rust-Seite ueber die Argumentform (`/C` statt
    // `-Command`); das Frontend hat hier nichts zu interpretieren.
    await registry.execute('shell_execute', { command: 'dir', shell: 'cmd', background: true })
    expect(startArgs().shell).toBe('cmd')
  })

  it('reicht `shell` zusammen mit `cwd` durch, ohne das eine gegen das andere zu tauschen', async () => {
    await registry.execute('shell_execute', {
      command: 'cargo build',
      cwd: '/repo',
      shell: 'powershell',
      background: true,
    })
    expect(startArgs()).toMatchObject({ command: 'cargo build', cwd: '/repo', shell: 'powershell' })
  })

  it('Vordergrund und Hintergrund sind sich beim selben `shell` einig', async () => {
    await registry.execute('shell_execute', { command: 'ls', shell: 'bash' })
    expect(execPayload().shell).toBe('bash')
    backendCalls.length = 0
    await registry.execute('shell_execute', { command: 'ls', shell: 'bash', background: true })
    expect(startArgs().shell).toBe('bash')
  })

  it('auch unter dem zurueckgezogenen Namen shell_execute_background', async () => {
    // Der Redirect reicht die ROHEN Modell-Argumente an denselben Executor
    // weiter — ohne den Fix in executeShellExecuteBg blieben sie hier haengen.
    const out = await registry.execute('shell_execute_background', {
      command: 'npm run dev',
      shell: 'bash',
    })
    expect(out).toContain('Task started: task-1')
    expect(startArgs().shell).toBe('bash')
  })

  it('NEGATIVKONTROLLE: ohne `shell` wird keins erfunden', async () => {
    await registry.execute('shell_execute', { command: 'sleep 5', background: true })
    // Kein String -> die Bridge faellt auf `default_shell` zurueck, wie bisher.
    expect(startArgs().shell).toBeUndefined()
  })

  it('NEGATIVKONTROLLE: ein Nicht-String aus dem Modell wird verworfen, nicht weitergereicht', async () => {
    // `args` kommen vom MODELL, das Schema ist nur ein Hinweis im Prompt. Ein
    // `shell: 123` an der Bridge waere ein Deserialisierungsfehler statt eines
    // Laufs — `argOptString` faengt das ab, anders als das vordere
    // `args.shell || null`.
    await registry.execute('shell_execute', { command: 'sleep 5', shell: 123, background: true })
    expect(startArgs().shell).toBeUndefined()
    backendCalls.length = 0
    await registry.execute('shell_execute', { command: 'sleep 5', shell: '', background: true })
    expect(startArgs().shell).toBeUndefined()
  })
})
