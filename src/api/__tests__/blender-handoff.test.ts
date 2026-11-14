// Create, 3D to Blender: what the frontend sends to Rust and what the menu shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
let tauri = true
let mobile = false
vi.mock('../in-tauri', () => ({ isTauri: () => tauri }))
vi.mock('../../lib/device-kind', () => ({ isMobile: () => mobile }))

import {
  BLENDER_TEXT, blenderHeaders, blenderMenu, blenderMenuHint, blenderModelName, forgetBlenderStatus,
  getBlenderStatus, makeWithBlender, openInBlender, stopBlender,
} from '../blender'
import { MESH_FORMATS } from '../../lib/three/mesh-export'

const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])

beforeEach(() => {
  invoke.mockReset()
  forgetBlenderStatus()
  tauri = true
  mobile = false
})
afterEach(() => vi.useRealTimers())

describe('status', () => {
  it('is not asked outside the desktop app or on a phone', async () => {
    tauri = false
    expect(await getBlenderStatus()).toBeNull()
    tauri = true
    mobile = true
    expect(await getBlenderStatus()).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('is asked once per half minute', async () => {
    vi.useFakeTimers()
    invoke.mockResolvedValue({ found: true, version: '5.2.1', tooOld: false, source: 'app' })
    expect((await getBlenderStatus())?.version).toBe('5.2.1')
    await getBlenderStatus()
    expect(invoke).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(31_000)
    await getBlenderStatus()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('a failing check means no Blender entries, not an error', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    expect(await getBlenderStatus()).toBeNull()
    expect(blenderMenu(null)).toEqual([])
  })
})

describe('calls', () => {
  it('the GLB goes as the raw body, the name as an encoded header', async () => {
    invoke.mockResolvedValue(4242)
    expect(await openInBlender(GLB, 'a red mug, "café"')).toBe(4242)
    const [cmd, body, opts] = invoke.mock.calls[0]
    expect(cmd).toBe('blender_open')
    expect(body).toBe(GLB)
    expect(opts.headers['x-lu-name']).toBe(encodeURIComponent('a red mug, "café"'))
    expect(decodeURIComponent(opts.headers['x-lu-name'])).toBe('a red mug, "café"')
  })

  it('a .blend or FBX comes back as bytes', async () => {
    invoke.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    const out = await makeWithBlender(GLB, 'Mug', 'fbx', 'job-1')
    expect(Array.from(out)).toEqual([1, 2, 3])
    const [cmd, body, opts] = invoke.mock.calls[0]
    expect(cmd).toBe('blender_convert')
    expect(body).toBe(GLB)
    expect(opts.headers).toEqual({ 'x-lu-name': 'Mug', 'x-lu-format': 'fbx', 'x-lu-job': 'job-1' })
  })

  it('stop names the job and never throws', async () => {
    invoke.mockRejectedValue(new Error('gone'))
    await expect(stopBlender('job-1')).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('blender_cancel', { job: 'job-1' }, undefined)
  })

  it('headers are plain ASCII whatever the name holds', () => {
    const h = blenderHeaders('ロボット\nnew line', { 'x-lu-format': 'blend' })
    for (const v of Object.values(h)) expect(v).toMatch(/^[\x20-\x7e]*$/)
  })
})

describe('menu', () => {
  it('a usable Blender gives three entries', () => {
    const entries = blenderMenu({ found: true, version: '5.2.1', tooOld: false, source: 'app' })
    expect(entries.map((e) => e.id)).toEqual(['open', 'blend', 'fbx'])
    expect(entries[0].label).toBe('Open in Blender')
    expect(blenderMenuHint({ found: true, version: '5.2.1', tooOld: false, source: 'app' })).toBeNull()
  })

  it('an old Blender gives no entries and one honest line', () => {
    const old = { found: true, version: '2.93.1', tooOld: true, source: 'app' }
    expect(blenderMenu(old)).toEqual([])
    expect(blenderMenuHint(old)).toBe(BLENDER_TEXT.tooOld('2.93.1'))
  })

  it('without Blender the GLB entry says it is the one for Blender', () => {
    expect(blenderMenu({ found: false, version: null, tooOld: false, source: null })).toEqual([])
    expect(MESH_FORMATS.find((f) => f.id === 'glb')?.note).toMatch(/best for Blender/)
  })

  it('texts end without a closing pleasantry', () => {
    const all = [BLENDER_TEXT.open, BLENDER_TEXT.blend, BLENDER_TEXT.fbx, BLENDER_TEXT.fbxNote, BLENDER_TEXT.blendNote, BLENDER_TEXT.tooOld('3.0')]
    for (const t of all) expect(t).not.toMatch(/should work|hope|enjoy/i)
  })
})

describe('name', () => {
  it('the prompt, cut at a word', () => {
    expect(blenderModelName({ prompt: 'a small friendly robot, toy style' })).toBe('a small friendly robot, toy style')
    expect(blenderModelName({ prompt: 'a very old wooden chair with carved legs and a red velvet seat' })).toBe('a very old wooden chair with carved legs')
    expect(blenderModelName({ prompt: '', label: 'From a picture' })).toBe('From a picture')
    expect(blenderModelName({ prompt: '  ' })).toBe('LU model')
  })
})
