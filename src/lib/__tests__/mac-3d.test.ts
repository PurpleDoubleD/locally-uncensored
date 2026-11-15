/**
 * One model of the Mac's 3D engine, as Create waits for it
 * (api/mlx-3d.ts runMacMesh3d over commands/mesh3d.rs), and the words of
 * its progress line (lib/mac-3d.ts).
 *
 * The commands are mocked: what is held here is what goes to Rust, how the
 * polls are read, and that a Stop reaches the run it was meant for.
 *
 * Run: npx vitest run src/lib/__tests__/mac-3d.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rust = vi.hoisted(() => ({
  calls: [] as { cmd: string; args?: Record<string, unknown> }[],
  polls: [] as Record<string, unknown>[],
}))
vi.mock('../../api/mlx-invoke', () => ({
  invokeMedia: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    rust.calls.push({ cmd, args })
    if (cmd === 'mlx_mesh3d_generate') {
      return { ok: true, jobId: 'j1', run: args?.run, output: '/c/3d/r.glb', resolution: args?.resolution ?? 256, cutout: args?.cutout ?? true }
    }
    if (cmd === 'mlx_mesh3d_progress') return rust.polls.shift() ?? poll('running')
    if (cmd === 'mlx_mesh3d_cancel') return { ok: true, stopped: true }
    if (cmd.startsWith('mlx_mesh3d_')) return { ok: true }
    throw new Error(`unexpected ${cmd}`)
  }),
}))

import {
  runMacMesh3d,
  generateMesh3d,
  getMesh3dStatus,
  installMesh3d,
  getMesh3dInstallStatus,
  cancelMesh3dInstall,
  deleteMesh3dModel,
  cancelMesh3d,
  mesh3dModelOf,
  type Mesh3dStatus,
  Mesh3dRunCancelled,
  Mesh3dNoObject,
} from '../../api/mlx-3d'
import { mesh3dRunLine, mac3dResolution, mac3dTexture, mac3dModel, MAC_3D_MODELS, MESH3D_PHASE_TEXT, MAC_3D_MODEL_NAME, MESH3D_NO_OBJECT } from '../mac-3d'

function poll(status: string, extra: Record<string, unknown> = {}) {
  return { job: 'j1', run: 'r', status, phase: 'shape', detail: '', percent: 40, error: null, errorCode: null, output: '/c/3d/r.glb', triangles: null, vertices: null, device: 'mps', logs: [], running: status === 'running', pid: 7, ...extra }
}

beforeEach(() => {
  vi.useFakeTimers()
  rust.calls.length = 0
  rust.polls.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

async function settle<T>(p: Promise<T>): Promise<T> {
  const out = p.then((value) => ({ value }), (error: unknown) => ({ error }))
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1000)
  const r = await out
  if ('error' in r) throw r.error
  return r.value
}

describe('the progress line', () => {
  it('says each phase in the words of the plan', () => {
    expect(Object.values(MESH3D_PHASE_TEXT)).toEqual([
      'Getting the model ready…',
      'Cutting out your object…',
      'Building the shape…',
      'Painting the surface…',
      'Saving your model…',
    ])
    expect(mesh3dRunLine({ phase: 'cutout' }, 3)).toBe('Cutting out your object… (3s)')
    expect(mesh3dRunLine({ phase: 'paint' }, 41.6)).toBe('Painting the surface… (42s)')
    expect(mesh3dRunLine({ phase: 'something new' }, 0)).toBe('Getting the model ready… (0s)')
    expect(mesh3dRunLine({ phase: null }, -2)).toBe('Getting the model ready… (0s)')
  })

  it('no text has a dash, a German word or a closing phrase', () => {
    for (const text of [...Object.values(MESH3D_PHASE_TEXT), MESH3D_NO_OBJECT]) {
      expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]| - `))
      expect(text).not.toMatch(/should work|hope|enjoy/i)
    }
  })

  it('maps Detail to the grid Rust takes', () => {
    expect(mac3dResolution('draft')).toBe(128)
    expect(mac3dResolution('standard')).toBe(256)
    expect(mac3dResolution('fine')).toBe(384)
    expect(mac3dResolution(undefined)).toBe(256)
    // Rust's bounds and steps (resolution_for in mesh3d.rs).
    const rs = readFileSync(join(__dirname, '../../../src-tauri/src/commands/mesh3d.rs'), 'utf8')
    expect(rs).toContain('const MIN_RESOLUTION: u32 = 64;')
    expect(rs).toContain('const MAX_RESOLUTION: u32 = 384;')
    expect(rs).toContain(`pub(crate) const MODEL_NAME: &str = "${MAC_3D_MODEL_NAME}";`)
    expect(rs).toContain(`const NO_OBJECT: &str = "${MESH3D_NO_OBJECT}";`)
    for (const phase of Object.keys(MESH3D_PHASE_TEXT)) expect(rs).toContain(`"${phase}"`)
  })
})

describe('the commands', () => {
  it('each wrapper calls its Rust command, and only those of media_cmds.rs', async () => {
    await getMesh3dStatus()
    await installMesh3d()
    await getMesh3dInstallStatus()
    await cancelMesh3dInstall()
    await deleteMesh3dModel()
    await cancelMesh3d('r9')
    const names = rust.calls.map((c) => c.cmd)
    expect(names).toEqual(['mlx_mesh3d_status', 'mlx_mesh3d_install', 'mlx_mesh3d_install_status', 'mlx_mesh3d_cancel_install', 'mlx_mesh3d_delete', 'mlx_mesh3d_cancel'])
    expect(rust.calls.at(-1)!.args).toEqual({ run: 'r9' })
    // Install and remove name their model; TripoSR when the caller names none.
    expect(rust.calls[1].args).toEqual({ model: 'triposr' })
    expect(rust.calls[4].args).toEqual({ model: 'triposr' })
    await installMesh3d('sf3d')
    await deleteMesh3dModel('sf3d')
    expect(rust.calls.slice(-2).map((c) => c.args)).toEqual([{ model: 'sf3d' }, { model: 'sf3d' }])
    const media = readFileSync(join(__dirname, '../../../src-tauri/src/commands/media_cmds.rs'), 'utf8')
    const lib = readFileSync(join(__dirname, '../../../src-tauri/src/lib.rs'), 'utf8')
    for (const name of [...names, 'mlx_mesh3d_generate', 'mlx_mesh3d_progress']) {
      expect(media).toContain(`pub async fn ${name}(`)
      expect(lib).toContain(`commands::media_cmds::${name},`)
    }
  })

  it('generate sends the run, the staged picture, and the options only when set', async () => {
    await generateMesh3d({ run: 'r', imagePath: '/s/start-images/a.png' })
    expect(rust.calls[0].args).toEqual({ run: 'r', imagePath: '/s/start-images/a.png' })
    await generateMesh3d({ run: 'r', imagePath: '/s/a.png', resolution: 128, cutout: false })
    expect(rust.calls[1].args).toEqual({ run: 'r', imagePath: '/s/a.png', resolution: 128, cutout: false })
    await generateMesh3d({ run: 'r', imagePath: '/s/a.png', model: 'sf3d', texture: 2048 })
    expect(rust.calls[2].args).toEqual({ run: 'r', imagePath: '/s/a.png', model: 'sf3d', texture: 2048 })
  })
})

describe('the models of the lane', () => {
  it('lists TripoSR first and Stable Fast 3D as gated, under the ids and names Rust uses', () => {
    expect(MAC_3D_MODELS.map((m) => m.id)).toEqual(['triposr', 'sf3d'])
    expect(MAC_3D_MODELS.map((m) => m.gated)).toEqual([false, true])
    expect(mac3dModel('sf3d').name).toBe('Stable Fast 3D')
    expect(mac3dModel('nonsense').id).toBe('triposr')
    expect(mac3dModel(undefined).id).toBe('triposr')
    const rs = readFileSync(join(__dirname, '../../../src-tauri/src/commands/mesh3d_sf3d.rs'), 'utf8')
    expect(rs).toContain('pub(crate) const MODEL_ID: &str = "sf3d";')
    expect(rs).toContain(`pub(crate) const MODEL_NAME: &str = "${mac3dModel('sf3d').name}";`)
    for (const m of MAC_3D_MODELS) {
      expect(m.line).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]| - `))
    }
  })

  it('maps Detail to the texture sides Rust takes', () => {
    expect([mac3dTexture('draft'), mac3dTexture('standard'), mac3dTexture('fine'), mac3dTexture(undefined)]).toEqual([512, 1024, 2048, 1024])
    const rs = readFileSync(join(__dirname, '../../../src-tauri/src/commands/mesh3d_sf3d.rs'), 'utf8')
    expect(rs).toContain('const TEXTURES: [u32; 3] = [512, 1024, 2048];')
  })

  it('finds a card in the list and TripoSR in the old field', () => {
    const triposr = { id: 'triposr', name: 'TripoSR', installed: true } as Mesh3dStatus['model']
    const sf3d = { id: 'sf3d', name: 'Stable Fast 3D', installed: false, gated: true } as Mesh3dStatus['model']
    const both = { model: triposr, models: [triposr, sf3d] } as Mesh3dStatus
    expect(mesh3dModelOf(both, 'sf3d')?.gated).toBe(true)
    expect(mesh3dModelOf({ model: triposr } as Mesh3dStatus, 'triposr')?.installed).toBe(true)
    expect(mesh3dModelOf({ model: triposr } as Mesh3dStatus, 'sf3d')).toBeNull()
  })
})

describe('a run', () => {
  it('reports the phases and ends with the path, the size and the triangles', async () => {
    rust.polls.push(poll('running', { phase: 'cutout', percent: 2 }), poll('running', { phase: 'paint', percent: 82 }), poll('complete', { percent: 100, phase: 'save', bytes: 4096, triangles: 51234 }))
    const seen: [number, string][] = []
    const result = await settle(runMacMesh3d({ imagePath: '/s/a.png', resolution: 256 }, { onProgress: (p, t) => seen.push([p, t]) }))
    const start = rust.calls.find((c) => c.cmd === 'mlx_mesh3d_generate')!
    expect(String(start.args?.run)).toMatch(/^mesh3d-\d+-\d+$/)
    expect(result).toEqual({ path: '/c/3d/r.glb', bytes: 4096, triangles: 51234, seconds: expect.any(Number) })
    expect(seen[0][1]).toMatch(/^Cutting out your object… \(\d+s\)$/)
    expect(seen[1][1]).toMatch(/^Painting the surface…/)
    expect(seen.every(([p]) => p <= 99)).toBe(true)
  })

  it('a poll of the run before this one is not this one', async () => {
    rust.polls.push(poll('complete', { job: 'older' }), poll('complete', { bytes: 1 }))
    const result = await settle(runMacMesh3d({ imagePath: '/s/a.png' }))
    expect(result.bytes).toBe(1)
    expect(rust.calls.filter((c) => c.cmd === 'mlx_mesh3d_progress')).toHaveLength(2)
  })

  it('a picture without an object rejects in the words of Create', async () => {
    rust.polls.push(poll('error', { error: MESH3D_NO_OBJECT, errorCode: 'no_object' }))
    await expect(settle(runMacMesh3d({ imagePath: '/s/a.png' }))).rejects.toBeInstanceOf(Mesh3dNoObject)
  })

  it('any other failure says why', async () => {
    rust.polls.push(poll('error', { error: 'The 3D engine stopped: out of memory' }))
    await expect(settle(runMacMesh3d({ imagePath: '/s/a.png' }))).rejects.toThrow('out of memory')
  })

  it('a Stop ends the run it was meant for and rejects as cancelled', async () => {
    const stop = new AbortController()
    const running = runMacMesh3d({ imagePath: '/s/a.png' }, { signal: stop.signal })
    const outcome = running.then(() => 'done', (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000)
    stop.abort()
    await vi.advanceTimersByTimeAsync(10)
    expect(await outcome).toBeInstanceOf(Mesh3dRunCancelled)
    const run = rust.calls.find((c) => c.cmd === 'mlx_mesh3d_generate')!.args!.run
    expect(rust.calls.find((c) => c.cmd === 'mlx_mesh3d_cancel')!.args).toEqual({ run })
  })

  it('a run Rust reports as cancelled rejects as cancelled', async () => {
    rust.polls.push(poll('cancelled'))
    await expect(settle(runMacMesh3d({ imagePath: '/s/a.png' }))).rejects.toBeInstanceOf(Mesh3dRunCancelled)
  })
})
