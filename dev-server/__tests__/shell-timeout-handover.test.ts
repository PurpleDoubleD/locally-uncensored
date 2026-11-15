/**
 * T1 on the bench: the dev server's /local-api/shell-execute does what the
 * app's shell_execute does when the timeout hits and the caller asked for the
 * handover. The command runs on as a task, the answer carries `taskId` and
 * the output so far, and the shell_task_* routes read and stop it with the
 * Rust shapes. Without the switch the timeout still kills, as before.
 *
 * Real handler (registerExecRoutes), real socket, real processes. POSIX only:
 * the commands are `bash`, and the kill check reads a pid from `$!`.
 *
 * Run: npx vitest run dev-server/__tests__/shell-timeout-handover.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerExecRoutes } from '../exec-routes'
import { killAllDevTasks } from '../shell-tasks'
import { anfrage, routeHolen } from './echte-anfrage'

const ws = mkdtempSync(join(tmpdir(), 'lu-t1-'))
afterAll(() => {
  killAllDevTasks()
  rmSync(ws, { recursive: true, force: true })
})

async function post(path: string, body: Record<string, unknown>) {
  const handler = routeHolen(registerExecRoutes, path)
  const r = await anfrage(handler, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: r.json() as Record<string, unknown> }
}

const shell = (command: string, timeout: number, handOver: boolean) =>
  post('/local-api/shell-execute', { command, timeout, shell: 'bash', workingDirectory: ws, backgroundOnTimeout: handOver })
const status = (id: string) => post('/local-api/shell-task-status', { args: { id } })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(process.platform === 'win32')('dev server: timeout hands over to a task', () => {
  it('answers with the task id and the output so far, and the task finishes on its own', async () => {
    const r = await shell('echo before; sleep 1; echo after', 300, true)
    expect(r.status).toBe(200)
    expect(r.json.timedOut).toBe(true)
    expect(r.json.exitCode).toBe(-1)
    expect(String(r.json.stdout)).toContain('before')
    expect(String(r.json.stdout)).not.toContain('after')
    const id = String(r.json.taskId)
    expect(id).toMatch(/[0-9a-f-]{36}/)

    const first = await status(id)
    expect(first.json.running).toBe(true)
    await until(async () => (await status(id)).json.running === false)
    const done = await status(id)
    expect(done.json.exit_code).toBe(0)
    expect(String(done.json.output_tail)).toContain('after')

    const list = await post('/local-api/shell-task-list', { args: {} })
    expect((list.json.tasks as { id: string }[]).map((t) => t.id)).toContain(id)
  })

  it('kill takes the task and its children down', async () => {
    const r = await shell('sleep 30 & echo $!; wait', 300, true)
    const id = String(r.json.taskId)
    const worker = Number(String(r.json.stdout).trim().split('\n')[0])
    expect(alive(worker)).toBe(true)

    const k = await post('/local-api/shell-task-kill', { args: { id } })
    expect(k.json).toEqual({ ok: true, cancelled: true })
    await until(() => !alive(worker))
    await until(async () => (await status(id)).json.running === false)
    expect((await status(id)).json.cancelled).toBe(true)
  })

  it('without the switch the timeout still kills', async () => {
    const r = await shell('sleep 30', 300, false)
    expect(r.json.timedOut).toBe(true)
    expect(r.json.taskId).toBeUndefined()
  })

  it('an unknown task id is a 404', async () => {
    expect((await status('nope')).status).toBe(404)
  })
})
