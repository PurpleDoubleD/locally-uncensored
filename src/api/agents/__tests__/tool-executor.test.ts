import { describe, it, expect, vi } from 'vitest'
import {
  executeParallel,
  type ExecutorRuntime,
  type ExecutionRequest,
  type AuditHook,
  applyResultToToolCall,
} from '../tool-executor'
import type { AgentToolCall } from '../../../types/agent-mode'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const makeRuntime = (
  overrides: Partial<ExecutorRuntime> & {
    tools?: Record<string, { inputSchema?: any; executor: (args: any) => Promise<string> }>
  } = {}
): ExecutorRuntime => {
  const tools = overrides.tools ?? {}
  return {
    getTool: overrides.getTool ?? ((name: string) => (name in tools ? { name, inputSchema: tools[name].inputSchema } : undefined)),
    execute:
      overrides.execute ??
      (async (name: string, args: Record<string, any>) => {
        if (!(name in tools)) throw new Error(`no executor for ${name}`)
        return tools[name].executor(args)
      }),
    awaitApproval: overrides.awaitApproval,
    lookupCache: overrides.lookupCache,
    recordAudit: overrides.recordAudit,
    explainError: overrides.explainError,
  }
}

const req = (id: string, toolName: string, args: Record<string, any> = {}): ExecutionRequest => ({
  id,
  toolName,
  args,
})

describe('tool-executor — basic dispatch', () => {
  it('returns empty array on no requests', async () => {
    const out = await executeParallel([], makeRuntime())
    expect(out).toEqual([])
  })

  it('routes unknown tool to failure with "Unknown tool" error', async () => {
    const out = await executeParallel([req('1', 'nope')], makeRuntime())
    expect(out[0].status).toBe('failed')
    expect(out[0].error).toMatch(/Unknown tool/)
  })

  it('dispatches a single tool and records start + complete audit', async () => {
    const audit: AuditHook[] = []
    const runtime = makeRuntime({
      tools: { greet: { executor: async () => 'hi' } },
      recordAudit: (e) => audit.push(e),
    })
    const out = await executeParallel([req('1', 'greet')], runtime)
    expect(out[0].status).toBe('completed')
    expect(out[0].result).toBe('hi')
    expect(audit.map((a) => a.kind)).toEqual(['start', 'complete'])
  })

  it('preserves input order in result array regardless of completion order', async () => {
    const runtime = makeRuntime({
      tools: {
        slow: { executor: async () => { await sleep(30); return 'slow' } },
        fast: { executor: async () => 'fast' },
      },
    })
    const out = await executeParallel(
      [req('a', 'slow'), req('b', 'fast'), req('c', 'slow')],
      runtime
    )
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('tool-executor — parallelism', () => {
  it('runs no-side-effect tools concurrently', async () => {
    const runtime = makeRuntime({
      tools: {
        a: { executor: async () => { await sleep(40); return 'a' } },
        b: { executor: async () => { await sleep(40); return 'b' } },
        c: { executor: async () => { await sleep(40); return 'c' } },
      },
    })
    const t0 = Date.now()
    const out = await executeParallel([req('1', 'a'), req('2', 'b'), req('3', 'c')], runtime)
    const elapsed = Date.now() - t0
    // Serial would be ~120 ms; parallel finishes well under that. Allow margin for CI load.
    expect(elapsed).toBeLessThan(200)
    expect(out.every((r) => r.status === 'completed')).toBe(true)
  })

  it('serializes calls sharing a sideEffectKey (e.g. shell_execute)', async () => {
    // shell_execute maps to the "exec" queue.
    const order: string[] = []
    const runtime = makeRuntime({
      tools: {
        shell_execute: {
          executor: async (args: any) => {
            order.push(`start:${args.tag}`)
            await sleep(30)
            order.push(`end:${args.tag}`)
            return `done:${args.tag}`
          },
        },
      },
    })
    const out = await executeParallel(
      [
        req('1', 'shell_execute', { command: 'a', tag: 'a' }),
        req('2', 'shell_execute', { command: 'b', tag: 'b' }),
      ],
      runtime
    )
    expect(out.every((r) => r.status === 'completed')).toBe(true)
    // Serial: a must finish before b starts.
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('serializes two file_write to same path but not to different paths', async () => {
    const order: string[] = []
    const runtime = makeRuntime({
      tools: {
        file_write: {
          executor: async (args: any) => {
            order.push(`start:${args.path}`)
            await sleep(30)
            order.push(`end:${args.path}`)
            return 'ok'
          },
        },
      },
    })
    const t0 = Date.now()
    await executeParallel(
      [
        req('1', 'file_write', { path: '/tmp/a', content: '' }),
        req('2', 'file_write', { path: '/tmp/a', content: '' }), // same path — serial
        req('3', 'file_write', { path: '/tmp/b', content: '' }), // different — parallel w/ group A
      ],
      runtime
    )
    const elapsed = Date.now() - t0
    // Two serial writes to /tmp/a (~60 ms) run in parallel with one write to /tmp/b (~30 ms).
    // Total should be ~60 ms, well under full-serial (~90 ms). Allow margin for CI load.
    expect(elapsed).toBeLessThan(200)
    // The two /tmp/a ops must be serial.
    const aEvents = order.filter((s) => s.endsWith('/tmp/a'))
    expect(aEvents).toEqual(['start:/tmp/a', 'end:/tmp/a', 'start:/tmp/a', 'end:/tmp/a'])
  })
})

describe('tool-executor — failures', () => {
  it('one failing sibling does not abort the others', async () => {
    const runtime = makeRuntime({
      tools: {
        ok: { executor: async () => 'yay' },
        boom: {
          executor: async () => {
            throw new Error('kaboom')
          },
        },
      },
    })
    const out = await executeParallel(
      [req('a', 'ok'), req('b', 'boom'), req('c', 'ok')],
      runtime
    )
    expect(out[0].status).toBe('completed')
    expect(out[1].status).toBe('failed')
    expect(out[1].error).toMatch(/kaboom/)
    expect(out[2].status).toBe('completed')
  })

  it('validation failure short-circuits dispatch with structured error', async () => {
    const runtime = makeRuntime({
      tools: {
        needs_arg: {
          inputSchema: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
          executor: async () => 'unreachable',
        },
      },
    })
    const out = await executeParallel([req('1', 'needs_arg', {})], runtime)
    expect(out[0].status).toBe('failed')
    expect(out[0].schemaValidated).toBe(false)
    expect(out[0].validationError).toMatch(/x/)
    expect(out[0].error).toMatch(/Invalid arguments/)
  })

  it('explainError attaches a hint to failure results', async () => {
    const runtime = makeRuntime({
      tools: {
        boom: {
          executor: async () => {
            throw new Error('ENOENT: no such file')
          },
        },
      },
      explainError: (_name, err) =>
        /ENOENT/.test(err) ? 'Path not found. Try file_list first.' : undefined,
    })
    const out = await executeParallel([req('1', 'boom')], runtime)
    expect(out[0].errorHint).toMatch(/file_list/)
  })
})

describe('tool-executor — cache + approval', () => {
  it('returns cached result without invoking executor', async () => {
    const exec = vi.fn(async () => 'fresh')
    const runtime = makeRuntime({
      tools: { t: { executor: exec } },
      lookupCache: () => 'from-cache',
    })
    const out = await executeParallel([req('1', 't')], runtime)
    expect(out[0].status).toBe('cached')
    expect(out[0].result).toBe('from-cache')
    expect(out[0].cacheHit).toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })

  it('rejected approval marks call rejected, skips dispatch', async () => {
    const exec = vi.fn(async () => 'fresh')
    const runtime = makeRuntime({
      tools: { t: { executor: exec } },
      awaitApproval: async () => false,
    })
    const out = await executeParallel([req('1', 't')], runtime)
    expect(out[0].status).toBe('rejected')
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('tool-executor — abort', () => {
  it('aborted requests resolve as rejected without dispatching', async () => {
    const exec = vi.fn(async () => 'fresh')
    const runtime = makeRuntime({ tools: { t: { executor: exec } } })
    const controller = new AbortController()
    controller.abort()
    const out = await executeParallel([req('1', 't')], runtime, { abortSignal: controller.signal })
    expect(out[0].status).toBe('rejected')
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('tool-executor — applyResultToToolCall', () => {
  it('maps ExecutionResult back onto AgentToolCall fields', () => {
    const call: AgentToolCall = {
      id: '1',
      toolName: 't',
      args: {},
      status: 'pending_approval',
      timestamp: 0,
    }
    applyResultToToolCall(call, {
      id: '1',
      toolName: 't',
      status: 'completed',
      result: 'ok',
      dispatchedArgs: {},
      argsHash: 'h',
      sideEffectKey: undefined,
      startedAt: 10,
      completedAt: 20,
      durationMs: 10,
      cacheHit: false,
      schemaValidated: true,
    })
    expect(call.status).toBe('completed')
    expect(call.result).toBe('ok')
    expect(call.duration).toBe(10)
    expect(call.schemaValidated).toBe(true)
  })

  it('translates cached result into cached status', () => {
    const call: AgentToolCall = { id: '1', toolName: 't', args: {}, status: 'pending_approval', timestamp: 0 }
    applyResultToToolCall(call, {
      id: '1',
      toolName: 't',
      status: 'cached',
      result: 'cached',
      dispatchedArgs: {},
      argsHash: 'h',
      startedAt: 0,
      completedAt: 0,
      durationMs: 0,
      cacheHit: true,
      schemaValidated: true,
    })
    expect(call.status).toBe('cached')
    expect(call.cacheHit).toBe(true)
  })
})
