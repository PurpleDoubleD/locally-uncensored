/**
 * PR #229 (kayleexlinu): the Juggernaut XL V9 download pointed at `main` of
 * RunDiffusion/Juggernaut-XL-v9, so a later push there could change the file
 * under the same name. It is pinned to the repo commit now, with the byte
 * count and LFS sha256 the Hugging Face tree API gives for that commit
 * (read 2026-11-14; main serves the same file).
 *
 * Run: npx vitest run src/api/__tests__/juggernaut-xl-is-pinned-229.test.ts
 */
import { describe, it, expect } from 'vitest'
import { getImageBundles } from '../model-bundles'

const file = () => getImageBundles().flatMap((b) => b.files).find((f) => f.filename === 'Juggernaut-XL_v9.safetensors')!

describe('Juggernaut XL V9 downloads one fixed file', () => {
  it('from the pinned commit of the official repo, checked by size and sha256', () => {
    expect(file().downloadUrl).toBe('https://huggingface.co/RunDiffusion/Juggernaut-XL-v9/resolve/cf419233522daa0b9ea36c3aff98fa2cab1fb0fb/Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors')
    expect(file().sizeBytes).toBe(7105348188)
    expect(file().sha256).toBe('c9e3e68f89b8e38689e1097d4be4573cf308de4e3fd044c64ca697bdb4aa8bca')
  })

  it('NEGATIVE CONTROL: no longer a moving branch, and the local name stays', () => {
    expect(file().downloadUrl).not.toMatch(/\/resolve\/main\//)
    expect(file().subfolder).toBe('checkpoints')
  })
})
