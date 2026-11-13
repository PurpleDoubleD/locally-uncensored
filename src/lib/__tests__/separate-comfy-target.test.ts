/**
 * C80 (3.1.0, GitHub #230): where a separate ComfyUI install goes.
 */
import { describe, it, expect } from 'vitest'
import { separateComfyTarget } from '../separate-comfy-target'

describe('separateComfyTarget', () => {
  it('puts a ComfyUI subfolder into a general folder', () => {
    expect(separateComfyTarget('D:\\AI', 'C:\\Users\\a\\ComfyUI', true)).toEqual({ ok: true, target: 'D:\\AI\\ComfyUI' })
    expect(separateComfyTarget('/mnt/big/', '/home/a/ComfyUI', false)).toEqual({ ok: true, target: '/mnt/big/ComfyUI' })
    expect(separateComfyTarget('D:\\', null, true)).toEqual({ ok: true, target: 'D:\\ComfyUI' })
  })

  it('takes a folder that already says ComfyUI as it is', () => {
    expect(separateComfyTarget('D:\\ComfyUI-LU', 'C:\\ComfyUI', true)).toEqual({ ok: true, target: 'D:\\ComfyUI-LU' })
    expect(separateComfyTarget('/opt/comfyui2', '/home/a/ComfyUI', false)).toEqual({ ok: true, target: '/opt/comfyui2' })
  })

  it('refuses the install LU already uses, also when picked as its parent', () => {
    const r1 = separateComfyTarget('C:\\Users\\a\\comfyui\\', 'C:\\Users\\a\\ComfyUI', true)
    expect(r1.ok).toBe(false)
    const r2 = separateComfyTarget('/home/a', '/home/a/ComfyUI', false)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toMatch(/already uses/)
    // Linux paths are case-sensitive: a different folder.
    expect(separateComfyTarget('/home/a/comfyui', '/home/a/ComfyUI', false).ok).toBe(true)
  })

  it('an empty pick is no target', () => {
    expect(separateComfyTarget('   ', '/x', false).ok).toBe(false)
  })
})
