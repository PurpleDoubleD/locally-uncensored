/**
 * C71: a local image on a Mac is ended by Rust the moment it stops moving
 * (the Image timeout). The agent's own wall clock for image_generate would
 * cut a long render that is still making steps, so there is none there.
 * Elsewhere, and in the cloud, the cap stays as it was.
 *
 * Run: npx vitest run src/lib/__tests__/mac-image-tool-has-no-wall-clock-c71.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ mac: false }))
vi.mock('../capabilities', async (o) => ({ ...(await o<typeof import('../capabilities')>()), hasMlx: () => host.mac }))

import { MEDIA_CALL_OVERHEAD_MS, NO_PRACTICAL_CAP_MS, toolCallCapMs } from '../tool-timeout'

afterEach(() => { host.mac = false })

describe('the cap of image_generate', () => {
  it('a Mac, local: no wall clock, Rust ends a stalled render', () => {
    host.mac = true
    expect(toolCallCapMs('image_generate', {}, { imageGenTimeoutMinutes: 20, appMode: 'local' })).toBe(NO_PRACTICAL_CAP_MS)
    expect(toolCallCapMs('image_generate', {}, { imageGenTimeoutMinutes: 20 })).toBe(NO_PRACTICAL_CAP_MS)
  })

  it('COUNTER-CHECK: a Mac in cloud mode and every other desktop keep the cap', () => {
    host.mac = true
    expect(toolCallCapMs('image_generate', {}, { imageGenTimeoutMinutes: 20, appMode: 'cloud' })).toBe(20 * 60_000 + MEDIA_CALL_OVERHEAD_MS)
    host.mac = false
    expect(toolCallCapMs('image_generate', {}, { imageGenTimeoutMinutes: 20, appMode: 'local' })).toBe(20 * 60_000 + MEDIA_CALL_OVERHEAD_MS)
    // Video is not touched.
    host.mac = true
    expect(toolCallCapMs('video_generate', {}, { videoGenTimeoutMinutes: 60 })).toBe(60 * 60_000 + MEDIA_CALL_OVERHEAD_MS)
  })
})
