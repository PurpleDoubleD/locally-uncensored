import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CANCEL_ANSWER_LIMIT_MS, COMFY_BUSY_LONG_MS, comfyBusyLabel, settleWithin } from '../comfy-busy-line'

afterEach(() => { vi.useRealTimers() })

describe('ComfyUI does not answer during a render', () => {
  it('first says it is busy, after three minutes names the way out', () => {
    expect(comfyBusyLabel(20_000)).toBe('ComfyUI is busy and does not answer yet...')
    expect(comfyBusyLabel(COMFY_BUSY_LONG_MS - 1)).toContain('busy')
    expect(comfyBusyLabel(COMFY_BUSY_LONG_MS)).toBe('ComfyUI has not answered for 3 min. If it stays like this, cancel and try a smaller size.')
  })

  it('Cancel is free again when ComfyUI never answers', async () => {
    vi.useFakeTimers()
    let done = false
    void settleWithin(new Promise(() => {}), CANCEL_ANSWER_LIMIT_MS).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(CANCEL_ANSWER_LIMIT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('a failed cancel call counts as done and does not throw', async () => {
    await expect(settleWithin(Promise.reject(new Error('gone')), 1000)).resolves.toBeUndefined()
  })

  it('the busy line goes back to the phase once ComfyUI answers', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'hooks', 'useCreate.ts'), 'utf8')
    expect(src).toMatch(/else if \(silentSince !== null\) \{[\s\S]{0,120}silentSince = null\s+line\.setLabel\(phaseLabel\)/)
  })
})
