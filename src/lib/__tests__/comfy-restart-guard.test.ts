/**
 * R16 Befund 5, measured on the Windows box (2026-08-30): ComfyUI was killed
 * while the app kept running. Create then answered "ComfyUI is not running.
 * Wait for it to start." on every press, and nothing ever started it. Ten
 * minutes later port 8188 was still shut. LU starts ComfyUI at app launch and
 * nowhere else, so the sentence promised an actor that did not exist.
 *
 * House rule: self healing before an error message.
 *
 * Run: npx vitest run src/lib/__tests__/comfy-restart-guard.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  ensureComfyForRender, comfyIsManaged, comfyGuardMessage, RESTARTING_LINE,
  RESTART_ATTEMPTS, type ComfyGuardStatus,
} from '../comfy-restart-guard'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

const managed: ComfyGuardStatus = { isLocal: true, found: true, complete: true, running: false }

/** A probe that answers false a few times and then true, like a booting port. */
const portUpAfter = (n: number) => {
  let calls = 0
  return vi.fn(async () => ++calls > n)
}

const noWait = async () => {}

describe('what counts as ours to restart', () => {
  it('a local, found, complete install is ours', () => {
    expect(comfyIsManaged(managed)).toBe(true)
  })

  it('NEGATIVE: a remote host, a missing install and a carcass are not', () => {
    expect(comfyIsManaged({ ...managed, isLocal: false })).toBe(false)
    expect(comfyIsManaged({ ...managed, found: false })).toBe(false)
    // GH #98: the install is there but torch is broken. Starting it again only
    // reproduces the same crash.
    expect(comfyIsManaged({ ...managed, complete: false })).toBe(false)
    expect(comfyIsManaged(null)).toBe(false)
  })
})

describe('the guard in front of a render', () => {
  it('a running ComfyUI is left alone, and nothing is started', async () => {
    const start = vi.fn()
    const out = await ensureComfyForRender({
      probe: async () => true, status: async () => managed, start, wait: noWait,
    })
    expect(out).toBe('running')
    expect(start).not.toHaveBeenCalled()
  })

  it('a ComfyUI that died mid session is started again (Befund 5)', async () => {
    const start = vi.fn(async () => {})
    const lines: string[] = []
    const out = await ensureComfyForRender({
      probe: portUpAfter(3), status: async () => managed, start, wait: noWait,
      onProgress: (l) => lines.push(l),
    })
    expect(out).toBe('restarted')
    expect(start).toHaveBeenCalledTimes(1)
    // and it said what it was doing, with a counter that moves
    expect(lines[0]).toBe(RESTARTING_LINE)
    expect(lines.some((l) => /^Restarting ComfyUI\.\.\. \d+s$/.test(l))).toBe(true)
  })

  it('a start already under way is waited out, never doubled', async () => {
    // Two ComfyUI processes on one port is worse than none.
    const start = vi.fn()
    const out = await ensureComfyForRender({
      probe: portUpAfter(2), status: async () => ({ ...managed, starting: true }), start,
      wait: noWait,
    })
    expect(out).toBe('running')
    expect(start).not.toHaveBeenCalled()
  })

  it('NEGATIVE: a ComfyUI that is not ours is not touched, and the line says so', async () => {
    const start = vi.fn()
    const out = await ensureComfyForRender({
      probe: async () => false, status: async () => ({ ...managed, isLocal: false }), start,
      wait: noWait,
    })
    expect(out).toBe('unmanaged')
    expect(start).not.toHaveBeenCalled()
    const msg = comfyGuardMessage('unmanaged')
    expect(msg).toMatch(/not managed by LU/)
    // It must not promise that something is on its way.
    expect(msg).not.toMatch(/wait for it to start/i)
  })

  it('NEGATIVE: a ComfyUI that will not come up is tried a bounded number of times', async () => {
    // A crash on boot must not turn one click into an endless restart loop.
    const start = vi.fn(async () => {})
    const out = await ensureComfyForRender({
      probe: async () => false, status: async () => managed, start, wait: noWait, rounds: 2,
    })
    expect(out).toBe('failed')
    expect(start).toHaveBeenCalledTimes(RESTART_ATTEMPTS)
    expect(comfyGuardMessage('failed')).toMatch(/could not be restarted/)
    expect(comfyGuardMessage('failed')).not.toMatch(/wait for it to start/i)
  })

  it('a probe or status that throws does not take the render down with it', async () => {
    const out = await ensureComfyForRender({
      probe: async () => { throw new Error('proxy down') },
      status: async () => { throw new Error('no such command') },
      start: vi.fn(), wait: noWait,
    })
    // Nothing known about it, so nothing is claimed about it.
    expect(out).toBe('unmanaged')
  })

  it('a start command that will not even dispatch stops after the first try', async () => {
    const start = vi.fn(async () => { throw new Error('unknown command') })
    const out = await ensureComfyForRender({
      probe: async () => false, status: async () => managed, start, wait: noWait, rounds: 1,
    })
    expect(out).toBe('failed')
    expect(start).toHaveBeenCalledTimes(1)
  })
})

describe('the Create render uses the guard', () => {
  const src = read('src/hooks/useCreate.ts')

  it('the bare probe is gone and the guard stands in its place', () => {
    expect(src).toMatch(/const guard = await ensureComfyForRender\(\{/)
    expect(src).toMatch(/setError\(comfyGuardMessage\(guard\)\)/)
  })

  it('NEGATIVE: the empty promise is nowhere in the app any more', () => {
    expect(src).not.toContain('ComfyUI is not running. Wait for it to start.')
  })

  it('the waiting area is open while the restart runs, so the line can be read', () => {
    const openAt = src.indexOf("setProgress(0, 'Checking ComfyUI...')")
    const guardAt = src.indexOf('const guard = await ensureComfyForRender')
    expect(openAt).toBeGreaterThan(-1)
    expect(openAt).toBeLessThan(guardAt)
    expect(src).toMatch(/onProgress: \(line\) => setProgress\(0, line\)/)
  })
})
