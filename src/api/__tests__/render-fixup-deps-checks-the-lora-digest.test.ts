/**
 * B45: the Krea 2 style reference LoRA is not in the bundle catalogue (it
 * would need a VRAM figure of its own), so Create downloads it in place from
 * the component the builder names. Its sha256 travels with that component,
 * and the download is checked against it, as a catalogue file is.
 *
 * Run: npx vitest run src/api/__tests__/render-fixup-deps-checks-the-lora-digest.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

const got = vi.hoisted(() => ({ files: [] as Array<Record<string, unknown>> }))
vi.mock('../../lib/bundle-install', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  downloadBundleFiles: async (files: Array<Record<string, unknown>>) => { got.files = files },
  waitForModelsVisible: async () => true,
}))
vi.mock('../discover', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  modelsNotVisibleInComfy: async () => [],
}))

import { renderFixupDeps } from '../render-fixup-deps'
import { KREA2_STYLE_LORA } from '../../lib/frame-refs'

describe('a component download carries its own digest', () => {
  it('the Krea 2 style LoRA is checked against the sha256 Hugging Face states', async () => {
    await renderFixupDeps(() => undefined).download([{
      matchPatterns: [KREA2_STYLE_LORA.filename], downloadFilename: KREA2_STYLE_LORA.filename,
      downloadUrl: KREA2_STYLE_LORA.url, subfolder: 'loras', sizeGB: 0.43, sha256: KREA2_STYLE_LORA.sha256,
    }] as never).catch(() => undefined)
    expect(got.files).toEqual([expect.objectContaining({ filename: KREA2_STYLE_LORA.filename, subfolder: 'loras', sha256: KREA2_STYLE_LORA.sha256 })])
  })
})
