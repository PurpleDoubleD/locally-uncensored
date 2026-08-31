/**
 * Audit M1 — the terminal tool itself now sees Stop.
 *
 * "Stop is the only brake the product offers for an unattended agent with full
 * shell access, and it is ineffective for exactly the case you reach for it."
 * What the tool can promise depends on the phase:
 *
 *   not started yet  → refused; nothing runs.
 *   background task  → really killed, via the bridge's shell_task_kill.
 *   foreground child → NOT killable from here. Rust `shell_execute` takes no run
 *                      id and there is no shell_execute_cancel, so the process
 *                      runs to its own timeout. The executor stops WAITING on it
 *                      (see tool-executor-abort.test.ts), which ends the run and
 *                      frees the UI, but the child survives. Closing that hole
 *                      needs a bridge command; see the audit report.
 *
 * Run: npx vitest run src/api/mcp/__tests__/shell-honours-stop.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendCalls: { cmd: string; body: any }[] = []

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: any) => {
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

const ran = () => backendCalls.filter((c) => c.cmd === 'shell_execute')
const killed = () => backendCalls.filter((c) => c.cmd === 'shell_task_kill')

beforeEach(() => { backendCalls.length = 0 })

describe('shell_execute honours the run\'s Stop', () => {
  it('a command that has not started yet does not start', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await registry.execute(
      'shell_execute',
      { command: 'rm -rf build' },
      1,
      undefined,
      ctrl.signal,
    )
    expect(ran()).toHaveLength(0)
    expect(out).toMatch(/cancelled/i)
  })

  it('reads the signal off the run object too, for a nested sub-agent loop', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await registry.execute('shell_execute', { command: 'ls' }, 1, { abortSignal: ctrl.signal } as any)
    expect(ran()).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: a live run still runs its command', async () => {
    const ctrl = new AbortController()
    const out = await registry.execute('shell_execute', { command: 'echo hi' }, 1, undefined, ctrl.signal)
    expect(ran()).toHaveLength(1)
    expect(out).toBe('ran')
  })

  it('a BACKGROUND task started by the run is killed when the run is stopped', async () => {
    // The one shell path the bridge can genuinely cancel. Detached by design,
    // but nothing polls it once the run ends — so an unattended build or deploy
    // script would otherwise keep writing to the repo with no owner and no way
    // to reach it from the UI.
    const ctrl = new AbortController()
    const out = await registry.execute(
      'shell_execute',
      { command: 'npm run build', background: true },
      1,
      undefined,
      ctrl.signal,
    )
    expect(out).toContain('Task started: task-1')
    expect(killed()).toHaveLength(0)

    ctrl.abort()
    await new Promise((r) => setTimeout(r, 0))

    expect(killed()).toEqual([{ cmd: 'shell_task_kill', body: { args: { id: 'task-1' } } }])
  })

  it('NEGATIVE CONTROL: a background task on a live run is left alone', async () => {
    const ctrl = new AbortController()
    await registry.execute('shell_execute', { command: 'npm run dev', background: true }, 1, undefined, ctrl.signal)
    await new Promise((r) => setTimeout(r, 0))
    expect(killed()).toHaveLength(0)
  })

  it('the foreground path is documented as un-killable rather than pretending', () => {
    // If someone adds the bridge command, this comment (and this test) is the
    // marker that says where the real kill belongs.
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../builtin-tools.ts'), 'utf8')
    expect(src).toContain('the bridge has NO cancel for it')
  })
})
