/**
 * Audit M1 — "Stop hält app-weit nichts an", the executor half.
 *
 * The abort signal used to stop at the batch scheduler: executeParallel checked
 * it before dispatching a call and never again. So Stop kept the not-yet-started
 * calls of a batch from firing and did nothing whatsoever about the one that was
 * already running — a shell command kept mutating the repository for the rest of
 * its 615 s budget after the user pressed the only brake the product offers for
 * an unattended agent with full shell access.
 *
 * What is provable here (and is): the signal reaches the tool's own hands, an
 * approved-then-stopped call never dispatches, and a run that is stopped while a
 * tool is in flight stops WAITING instead of sitting out the tool's timeout.
 *
 * What is NOT provable here: that a foreground `shell_execute` child process
 * actually dies. The bridge has no cancel for it (no run id on shell_execute, no
 * shell_execute_cancel) — see the audit report.
 *
 * Run: npx vitest run src/api/agents/__tests__/tool-executor-abort.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeParallel, APPROVE_ALL, type ExecutorRuntime } from '../tool-executor'
import { ToolRegistry } from '../../mcp/tool-registry'
import type { MCPToolDefinition } from '../../mcp/types'
import type { AgentRunContext } from '../../agent-context'

/**
 * Ein Run-Kontext, in dem nur `abortSignal` etwas aussagt.
 *
 * Vorher stand hier `{ abortSignal } as any`. Das hat nicht nur den Typ
 * abgeschaltet, es hat auch die Frage verdeckt, ob ein Kontext ohne `token`
 * und `workspace` ueberhaupt einer ist — bekommt AgentRunContext ein weiteres
 * Pflichtfeld, faellt es jetzt hier auf statt still `undefined` zu sein.
 */
function runWithSignal(abortSignal: AbortSignal): AgentRunContext {
  return {
    token: 'abort-test-run',
    chatId: null,
    conversationId: null,
    workspace: null,
    artifactMode: false,
    readOnlyShellTurn: false,
    mode: null,
    artifacts: [],
    abortSignal,
  }
}

const tool = (name: string) => ({ name })

const mkRuntime = (over: Partial<ExecutorRuntime> = {}): ExecutorRuntime => ({
  getTool: (name) => tool(name),
  execute: async () => 'ok',
  awaitApproval: APPROVE_ALL,
  ...over,
})

describe('executeParallel — the run\'s Stop reaches the tool', () => {
  it('hands the abort signal to execute() as the fourth argument', async () => {
    const ctrl = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    await executeParallel(
      [{ id: '1', toolName: 'shell_execute', args: { command: 'ls' } }],
      mkRuntime({
        execute: async (_n, _a, _r, signal) => {
          seen.push(signal)
          return 'done'
        },
      }),
      { abortSignal: ctrl.signal },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(ctrl.signal)
  })

  it('falls back to the run\'s own signal when the caller passes none (nested loops)', async () => {
    // delegate_task's sub-agent carries the parent run, not the parent's opts.
    const ctrl = new AbortController()
    let seen: AbortSignal | undefined
    await executeParallel(
      [{
        id: '1',
        toolName: 'file_read',
        args: {},
        run: runWithSignal(ctrl.signal),
      }],
      mkRuntime({ execute: async (_n, _a, _r, signal) => { seen = signal; return 'done' } }),
    )
    expect(seen).toBe(ctrl.signal)
  })

  it('a tool that is ALREADY RUNNING when Stop lands does not hold the run', async () => {
    // The regression: a shell command whose own deadline is minutes away kept
    // the loop parked on its promise, so the typing dots stayed on, the VRAM
    // hand-off could not restore the text model, and nothing downstream ran.
    const ctrl = new AbortController()
    let released!: (v: string) => void
    const never = new Promise<string>((res) => { released = res })

    const p = executeParallel(
      [{ id: '1', toolName: 'shell_execute', args: { command: 'sleep 600' } }],
      mkRuntime({ execute: () => never }),
      { abortSignal: ctrl.signal },
    )
    // Let the dispatch happen, then stop.
    await Promise.resolve()
    ctrl.abort()

    const [res] = await p
    expect(res.status).toBe('rejected')
    expect(res.error).toBe('Aborted while running')
    // The tool promise is still outstanding; resolving it late must not throw.
    released('too late')
  })

  it('a call approved BEFORE Stop is not dispatched after it', async () => {
    // Approval can sit open for minutes — the schedule-time abort check is long
    // stale by the time the user clicks, and clicking Run is not consent to run
    // after they then press Stop.
    const ctrl = new AbortController()
    const execute = vi.fn(async () => 'ran')
    const [res] = await executeParallel(
      [{ id: '1', toolName: 'shell_execute', args: { command: 'rm -rf build' } }],
      mkRuntime({
        execute,
        awaitApproval: async () => {
          ctrl.abort()      // the user stops while the dialog is open
          return true       // …after having clicked Run
        },
      }),
      { abortSignal: ctrl.signal },
    )
    expect(execute).not.toHaveBeenCalled()
    expect(res.status).toBe('rejected')
    expect(res.error).toBe('Aborted before dispatch')
  })

  it('an already-aborted run dispatches nothing at all', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const execute = vi.fn(async () => 'ran')
    const results = await executeParallel(
      [
        { id: '1', toolName: 'file_write', args: { path: 'a' } },
        { id: '2', toolName: 'shell_execute', args: { command: 'x' } },
      ],
      mkRuntime({ execute }),
      { abortSignal: ctrl.signal },
    )
    expect(execute).not.toHaveBeenCalled()
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
  })
})

describe('ToolRegistry.execute — the signal keeps travelling', () => {
  const def = (name: string): MCPToolDefinition => ({
    name,
    description: 'x',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'terminal',
    source: 'builtin',
  })

  it('passes the signal into the tool executor', async () => {
    const registry = new ToolRegistry()
    const ctrl = new AbortController()
    let seen: AbortSignal | undefined
    registry.registerBuiltin(def('shell_execute'), async (_a, _r, signal) => {
      seen = signal
      return 'out'
    })
    await registry.execute('shell_execute', { command: 'ls' }, 1, undefined, ctrl.signal)
    expect(seen).toBe(ctrl.signal)
  })

  it('reads the signal off the run when the caller does not pass one', async () => {
    const registry = new ToolRegistry()
    const ctrl = new AbortController()
    let seen: AbortSignal | undefined
    registry.registerBuiltin(def('file_read'), async (_a, _r, signal) => { seen = signal; return 'x' })
    await registry.execute('file_read', {}, 1, runWithSignal(ctrl.signal))
    expect(seen).toBe(ctrl.signal)
  })

  it('refuses to start a tool on an already-stopped run', async () => {
    const registry = new ToolRegistry()
    const ctrl = new AbortController()
    ctrl.abort()
    const exec = vi.fn(async () => 'ran')
    registry.registerBuiltin(def('shell_execute'), exec)
    const out = await registry.execute('shell_execute', { command: 'ls' }, 1, undefined, ctrl.signal)
    expect(exec).not.toHaveBeenCalled()
    expect(out).toMatch(/cancelled by the user/i)
  })

  it('does not RETRY a transient failure after Stop — that would re-run the command', async () => {
    const registry = new ToolRegistry()
    const ctrl = new AbortController()
    let calls = 0
    registry.registerBuiltin(def('web_fetch'), async () => {
      calls++
      ctrl.abort()          // the user stops while the first attempt is failing
      return 'Error: fetch failed'
    })
    const out = await registry.execute('web_fetch', {}, 1, undefined, ctrl.signal)
    expect(calls).toBe(1)
    expect(out).toBe('Error: fetch failed')
  })

  it('NEGATIVE CONTROL: without a Stop, a transient failure still retries', async () => {
    const registry = new ToolRegistry()
    let calls = 0
    registry.registerBuiltin(def('web_fetch'), async () => {
      calls++
      return calls === 1 ? 'Error: fetch failed' : 'recovered'
    })
    expect(await registry.execute('web_fetch', {}, 1)).toBe('recovered')
    expect(calls).toBe(2)
  })
})

describe('both agent loops hand the signal down', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

  it('Codex and Agent mode both pass it into toolRegistry.execute', () => {
    // The registry is the last hop before the tool. A loop that only put the
    // signal in ExecutorOptions stopped scheduling and nothing else.
    for (const f of ['../../../hooks/useCodex.ts', '../../../hooks/useAgentChat.ts']) {
      expect(read(f)).toContain('toolRegistry.execute(name, args, 1,')
      expect(read(f)).toContain('signal ?? abort.signal')
    }
  })

  it('and still pass it as ExecutorOptions, which is what stops the un-started calls', () => {
    for (const f of ['../../../hooks/useCodex.ts', '../../../hooks/useAgentChat.ts']) {
      expect(read(f)).toContain('abortSignal: abort.signal,')
    }
  })
})
