/**
 * 3.0.8 D28 auf dem Mac: die Beschreibung je Foto geht im selben Aufruf wie
 * unter Windows an den Mac-Trainer (mlx_train_stage, Parameter `caption`),
 * mit dem Triggerwort vorn; Low VRAM (D20) erreicht den Mac nie.
 *
 * Run: npx vitest run src/api/__tests__/mlx-train-caption.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const io = vi.hoisted(() => ({
  mac: true,
  media: [] as { cmd: string; args?: Record<string, unknown> }[],
  backend: [] as { cmd: string; args?: Record<string, unknown> }[],
}))
vi.mock('../mlx-image', () => ({ isMlxImageHost: () => io.mac }))
vi.mock('../mlx-invoke', () => ({
  invokeMedia: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    io.media.push({ cmd, args })
    return cmd === 'mlx_train_stage' ? { staged: 'abc.png' } : { ok: true }
  }),
}))
vi.mock('../backend', async (orig) => ({
  ...(await orig<typeof import('../backend')>()),
  backendCall: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    io.backend.push({ cmd, args })
    return { status: 'started' }
  }),
}))

import { stageTrainingImage, startCharacterTraining } from '../trainer'
import { buildTrainCaption } from '../../lib/train-captions'

beforeEach(() => {
  io.mac = true
  io.media.length = 0
  io.backend.length = 0
})

describe('die Beschreibung je Foto auf dem Mac', () => {
  it('landet als caption im mlx_train_stage-Aufruf, Triggerwort vorn', async () => {
    await stageTrainingImage('luxfox', 'a.png', [1, 2], buildTrainCaption('luxfox', 'red jacket, beach'))
    expect(io.backend).toHaveLength(0)
    expect(io.media[0].cmd).toBe('mlx_train_stage')
    expect(io.media[0].args?.caption).toBe('luxfox, a photo of luxfox, red jacket, beach')
  })

  it('leer heisst der Standardsatz', async () => {
    await stageTrainingImage('luxfox', 'a.png', [1, 2], buildTrainCaption('luxfox', ''))
    expect(io.media[0].args?.caption).toBe('luxfox, a photo of luxfox')
  })

  it('Low VRAM geht nie an den Mac-Trainer', async () => {
    await startCharacterTraining('luxfox', 'luxfox', 'luxfox', 400, 'low-vram')
    expect(io.media[0].cmd).toBe('mlx_train_start')
    expect(io.media[0].args).not.toHaveProperty('preset')
    expect(io.backend).toHaveLength(0)
  })

  it('unter Windows und Linux geht das Rezept mit', async () => {
    io.mac = false
    await startCharacterTraining('luxfox', 'luxfox', 'luxfox', 400, 'low-vram')
    expect(io.backend[0]).toEqual({ cmd: 'start_character_training', args: { setId: 'luxfox', name: 'luxfox', triggerWord: 'luxfox', steps: 400, preset: 'low-vram', kind: null } })
  })
})
