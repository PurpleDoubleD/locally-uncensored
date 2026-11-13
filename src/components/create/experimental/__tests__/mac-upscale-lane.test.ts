/**
 * Enhance Image on the Mac (14.10.2026). It is a local tab there while an
 * upscaler is installed (SeedVR2 on the second image engine,
 * commands/mlx.rs mlx_upscale), which is what `mlxUpscale` carries. Without
 * one it stays locked, as it is on every local host. Windows, Linux and the
 * other mode are untouched by the flag.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/mac-upscale-lane.test.ts
 */
import { describe, it, expect } from 'vitest'
import { INTENT_MAP, isIntentAvailable, isIntentLocked, visibleIntents } from '../intents'

const ids = (mlxUpscale: boolean, cloudFeatures = true) =>
  visibleIntents('local', true, cloudFeatures, false, false, mlxUpscale).map((m) => m.id)

describe('the Enhance tab on the Mac', () => {
  it('is locked while no upscaler is installed', () => {
    expect(isIntentLocked(INTENT_MAP.upscale, 'local', true, false, false, false)).toBe(true)
    expect(isIntentAvailable('upscale', 'local', true, false, false, false)).toBe(false)
    // With the teasers off it is not in the bar at all.
    expect(ids(false, false)).not.toContain('upscale')
  })

  it('is a plain local tab once one is', () => {
    expect(isIntentLocked(INTENT_MAP.upscale, 'local', true, false, false, true)).toBe(false)
    expect(isIntentAvailable('upscale', 'local', true, false, false, true)).toBe(true)
    // With the teasers off it is still there: it is no teaser.
    expect(ids(true, false)).toEqual(['image', 'removebg', 'upscale', 'video', 'character', '3d'])
  })

  it('opens no other tab: Edit, Erase and Animate keep their own rules', () => {
    for (const id of ['edit', 'eraser', 'animate'] as const) {
      expect(isIntentAvailable(id, 'local', true, false, false, true), id).toBe(false)
    }
  })

  it('changes nothing on a ComfyUI host or in the other mode', () => {
    expect(visibleIntents('local', false, true, false, false, true)).toEqual(visibleIntents('local', false, true))
    expect(isIntentLocked(INTENT_MAP.upscale, 'local', false, false, false, true)).toBe(isIntentLocked(INTENT_MAP.upscale, 'local', false))
    expect(isIntentLocked(INTENT_MAP.upscale, 'cloud', true, false, false, false)).toBe(false)
  })
})
