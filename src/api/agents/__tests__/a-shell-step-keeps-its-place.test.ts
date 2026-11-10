/**
 * C59 bench, AG4 on the 9B: "back up config.json, then change the port".
 * The model sent `cp config.json config.json.bak` and the edit in one turn.
 * Shell and file edits sat on different queues and ran at the same time;
 * the edit won and the backup already held 8080. A shell command can touch
 * any file, so a batch with one keeps the order the model wrote.
 */
import { describe, it, expect } from 'vitest'
import { executeParallel, APPROVE_ALL, type ExecutorRuntime } from '../tool-executor'
import type { ToolArgs } from '../../mcp/types'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function runtime(order: string[]): ExecutorRuntime {
  const tools: Record<string, (a: ToolArgs) => Promise<string>> = {
    shell_execute: async (a) => { order.push(`start:shell:${String(a.command)}`); await sleep(40); order.push('end:shell'); return 'Done.' },
    file_edit: async (a) => { order.push(`start:edit:${String(a.path)}`); await sleep(5); order.push('end:edit'); return 'Edited' },
    file_read: async (a) => { order.push(`read:${String(a.path)}`); return 'x' },
  }
  return {
    getTool: (name) => (name in tools ? { name } : undefined),
    execute: async (name, args) => tools[name](args),
    awaitApproval: APPROVE_ALL,
  }
}

describe('a batch with a shell call keeps its order', () => {
  it('the copy finishes before the edit starts', async () => {
    const order: string[] = []
    await executeParallel([
      { id: '1', toolName: 'shell_execute', args: { command: 'cp config.json config.json.bak' } },
      { id: '2', toolName: 'file_edit', args: { path: 'config.json', old_string: '3000', new_string: '8080' } },
    ], runtime(order))
    expect(order).toEqual(['start:shell:cp config.json config.json.bak', 'end:shell', 'start:edit:config.json', 'end:edit'])
  })

  it('a read after the shell call sees what the shell did', async () => {
    const order: string[] = []
    await executeParallel([
      { id: '1', toolName: 'shell_execute', args: { command: 'npm run build' } },
      { id: '2', toolName: 'file_read', args: { path: 'dist/out.txt' } },
    ], runtime(order))
    expect(order.indexOf('read:dist/out.txt')).toBeGreaterThan(order.indexOf('end:shell'))
  })

  it('without a shell call, reads still run side by side', async () => {
    const order: string[] = []
    const t0 = Date.now()
    await executeParallel([
      { id: '1', toolName: 'file_read', args: { path: 'a' } },
      { id: '2', toolName: 'file_read', args: { path: 'b' } },
    ], runtime(order))
    expect(Date.now() - t0).toBeLessThan(200)
    expect(order.sort()).toEqual(['read:a', 'read:b'])
  })
})
