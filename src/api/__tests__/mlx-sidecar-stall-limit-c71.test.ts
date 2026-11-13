/**
 * C71: an image of the Mac's sidecar is ended only when it stops moving for
 * the Image timeout in Settings. The request carries that limit to Rust.
 *
 * Run: npx vitest run src/api/__tests__/mlx-sidecar-stall-limit-c71.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => [] as Array<{ cmd: string; args: Record<string, unknown> }>)
vi.mock('../mlx-invoke', () => ({
  invokeMedia: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    sent.push({ cmd, args })
    if (cmd === 'mlx_status') return { installed: true, running: true }
    if (cmd === 'mlx_image_models') return [{ id: 'chroma1-hd', family: 'diffusers', sizeGB: 27.5 }]
    if (cmd === 'mlx_generate_progress') return { running: false, step: 0, steps: 0 }
    return { image_base64: 'AA==', width: 1024, height: 1024 }
  }),
}))

import { generateMlxImageDataUrl, mlxGenerate } from '../mlx-image'
import { useSettingsStore } from '../../stores/settingsStore'

const generateCall = () => sent.find((c) => c.cmd === 'mlx_generate')!

beforeEach(() => { sent.length = 0 })

describe('the stall limit of a Mac image', () => {
  it('a sidecar run carries the Image timeout from Settings, in seconds', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, imageGenTimeoutMinutes: 45 } }))
    await generateMlxImageDataUrl({ prompt: 'a fox', model: 'chroma1-hd' })
    expect(generateCall().args.stall_timeout_secs).toBe(45 * 60)
  })

  it('20 minutes when the setting is not a number', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, imageGenTimeoutMinutes: undefined as unknown as number } }))
    await generateMlxImageDataUrl({ prompt: 'a fox', model: 'chroma1-hd' })
    expect(generateCall().args.stall_timeout_secs).toBe(20 * 60)
  })

  it('a bare call without the field sends none', async () => {
    await mlxGenerate({ prompt: 'a fox' })
    expect(generateCall().args).not.toHaveProperty('stall_timeout_secs')
  })
})
