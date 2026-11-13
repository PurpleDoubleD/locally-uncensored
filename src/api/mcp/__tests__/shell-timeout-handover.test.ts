/**
 * T1 (CA rebuild): a command that outruns its timeout is not killed but keeps
 * running as a background task, and the model learns that, with the output so
 * far and the task id. check_tasks then reads the moved task, Stop still
 * reaches it, and a long finished output comes back as head and tail with a
 * pointer to the rest.
 *
 * The Rust half (the handover itself, kill, the exit sweep) has its own tests
 * in src-tauri/src/commands/bg_tasks.rs (`handover_tests`).
 *
 * Run: npx vitest run src/api/mcp/__tests__/shell-timeout-handover.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCalls: { cmd: string; body: Record<string, unknown> }[] = []
/** What the next shell_execute answers. */
let shellReply: Record<string, unknown> = {}
/** What shell_task_status answers, per id. */
const statuses = new Map<string, Record<string, unknown>>()

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: Record<string, unknown>) => {
    backendCalls.push({ cmd, body })
    if (cmd === 'shell_execute') return shellReply
    if (cmd === 'shell_task_status') {
      const id = (body.args as { id: string }).id
      const s = statuses.get(id)
      if (!s) throw new Error(`task not found: ${id}`)
      return s
    }
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
import type { AgentRunContext } from '../../agent-context'
import { _resetShellTasksForTests, shellTasksOf } from '../../agents/bg-tasks'
import { SHELL_HEAD_CHARS, SHELL_TAIL_CHARS } from '../../agents/shell-result'

function makeRun(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    token: 'test-run',
    chatId: null,
    conversationId: 'conv-t1',
    workspace: null,
    artifactMode: false,
    readOnlyShellTurn: false,
    mode: null,
    artifacts: [],
    ...over,
  }
}

const registry = new ToolRegistry()
registerBuiltinTools(registry)

const TASK = '0f0e0d0c-1111-2222-3333-444455556666'

function runningStatus(output: string): Record<string, unknown> {
  return {
    id: TASK,
    command: 'npm run build',
    cwd: '/ws',
    started_at: Math.floor(Date.now() / 1000) - 130,
    finished_at: null,
    exit_code: null,
    running: true,
    cancelled: false,
    output_tail: output,
  }
}

beforeEach(() => {
  backendCalls.length = 0
  statuses.clear()
  _resetShellTasksForTests()
  shellReply = { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }
})

describe('a timeout hands the command over instead of killing it', () => {
  it('asks the backend for the handover', async () => {
    await registry.execute('shell_execute', { command: 'echo hi' }, 1, makeRun())
    const call = backendCalls.find((c) => c.cmd === 'shell_execute')
    expect(call?.body.backgroundOnTimeout).toBe(true)
  })

  it('tells the model the task id, the output so far and how to read or stop it', async () => {
    shellReply = { stdout: 'compiling 1/3\n', stderr: '', exitCode: -1, timedOut: true, taskId: TASK, timeoutMs: 120000 }
    const out = await registry.execute('shell_execute', { command: 'npm run build' }, 1, makeRun())
    expect(out).toContain(`in the background as task ${TASK}`)
    expect(out).toContain('Still running after 120 s')
    expect(out).toContain('compiling 1/3')
    expect(out).toContain('check_tasks')
    expect(out).toContain(`task "kill" and task_id "${TASK}"`)
    expect(out).not.toMatch(/^Timed out/)
    expect(shellTasksOf('conv-t1')).toEqual([TASK])
  })

  it('check_tasks reads the moved task of this conversation', async () => {
    shellReply = { stdout: 'compiling 1/3\n', stderr: '', exitCode: -1, timedOut: true, taskId: TASK, timeoutMs: 120000 }
    await registry.execute('shell_execute', { command: 'npm run build' }, 1, makeRun())
    statuses.set(TASK, runningStatus('compiling 1/3\ncompiling 2/3\n'))

    const listed = await registry.execute('check_tasks', {}, 1, makeRun())
    expect(listed).toContain(`task_id ${TASK}`)
    expect(listed).toContain('running')
    expect(listed).toContain('compiling 2/3')

    // Another conversation does not see it.
    const other = await registry.execute('check_tasks', {}, 1, makeRun({ conversationId: 'conv-other' }))
    expect(other).toBe('No background tasks in this conversation.')
  })

  it('check_tasks shows the end of a long task output and says where the rest is', async () => {
    shellReply = { stdout: '', stderr: '', exitCode: -1, timedOut: true, taskId: TASK }
    await registry.execute('shell_execute', { command: 'npm run build' }, 1, makeRun())
    statuses.set(TASK, runningStatus(`${'x'.repeat(5000)}THE-END`))
    const listed = await registry.execute('check_tasks', {}, 1, makeRun())
    expect(listed).toContain('THE-END')
    expect(listed).toContain('shell_execute with task "status"')
    expect(listed.length).toBeLessThan(3000)
  })

  it('a task the registry no longer knows is left out of check_tasks', async () => {
    shellReply = { stdout: '', stderr: '', exitCode: -1, timedOut: true, taskId: TASK }
    await registry.execute('shell_execute', { command: 'npm run build' }, 1, makeRun())
    const listed = await registry.execute('check_tasks', {}, 1, makeRun())
    expect(listed).toBe('No background tasks in this conversation.')
  })

  it('Stop after the handover kills the task', async () => {
    shellReply = { stdout: '', stderr: '', exitCode: -1, timedOut: true, taskId: TASK }
    const ctrl = new AbortController()
    await registry.execute('shell_execute', { command: 'npm run build' }, 1, makeRun(), ctrl.signal)
    expect(backendCalls.filter((c) => c.cmd === 'shell_task_kill')).toHaveLength(0)
    ctrl.abort()
    await new Promise((r) => setTimeout(r, 0))
    const kills = backendCalls.filter((c) => c.cmd === 'shell_task_kill')
    expect(kills).toHaveLength(1)
    expect(kills[0].body).toEqual({ args: { id: TASK } })
  })

  it('a backend without the handover keeps the old answer', async () => {
    shellReply = { stdout: '', stderr: 'Execution timed out after 1000ms', exitCode: -1, timedOut: true }
    const out = await registry.execute('shell_execute', { command: 'sleep 5' }, 1, makeRun())
    expect(out).toMatch(/^Timed out\./)
  })
})

describe('a long output comes back as head and tail', () => {
  it('keeps the start and the end, counts what was cut and names the id for the rest', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`)
    const stdout = `${lines.join('\n')}\n`
    shellReply = { stdout, stderr: '', exitCode: 0, timedOut: false, outputId: 'out-1' }
    const out = await registry.execute('shell_execute', { command: 'cat big.log' }, 1, makeRun())
    expect(out.startsWith('line 0\nline 1\n')).toBe(true)
    expect(out).toContain('line 1999')
    const cut = stdout.length - SHELL_HEAD_CHARS - SHELL_TAIL_CHARS
    expect(out).toContain(`[… ${cut} characters (`)
    expect(out).toContain('task_id "out-1"')
    expect(out.length).toBeLessThan(SHELL_HEAD_CHARS + SHELL_TAIL_CHARS + 300)
  })

  it('a short output is unchanged', async () => {
    shellReply = { stdout: 'hello\n', stderr: '', exitCode: 0, timedOut: false }
    expect(await registry.execute('shell_execute', { command: 'echo hello' }, 1, makeRun())).toBe('hello\n')
  })

  it('a failing command with a long stderr is cut the same way', async () => {
    const stderr = `${'e'.repeat(10000)}\nfatal: the real error`
    shellReply = { stdout: '', stderr, exitCode: 2, timedOut: false, outputId: 'out-2' }
    const out = await registry.execute('shell_execute', { command: 'make' }, 1, makeRun())
    expect(out.startsWith('Error (2):\n')).toBe(true)
    expect(out).toContain('fatal: the real error')
    expect(out).toContain('task_id "out-2"')
  })
})
