/**
 * The setup card of local Swap installs what Swap runs on.
 *
 * 3.1.3 integration, found on a Linux test machine: Swap on this computer
 * runs on Wan 2.2 Animate only (swapLocalModels), but its setup card took the
 * first motion bundle, Wan VACE. After that download Swap was still locked and
 * asked for the same card again.
 */
import { describe, expect, it } from 'vitest'
import { classifyModel } from '../../api/comfyui'
import { getMotionBundles } from '../../api/discover'
import { swapLocalModels } from '../create/swap-local'
import { starterBundleFor } from '../starter-bundle'

describe('the local Swap setup card', () => {
  it('installs the Wan 2.2 Animate bundle, not the VACE one of Motion', () => {
    const bundle = starterBundleFor('motion', 'swap_character')
    expect(bundle?.workflow).toBe('wananimate')
    // Motion itself keeps its light VACE starter.
    expect(starterBundleFor('motion', 'motion')?.workflow).toBe('wanvace')
    expect(starterBundleFor('motion', 'motion')?.name).toBe(getMotionBundles()[0].name)
  })

  it('leaves a model behind that unlocks Swap', () => {
    const bundle = starterBundleFor('motion', 'swap_character')!
    const main = bundle.files.find((f) => f.subfolder === 'diffusion_models')
    expect(main?.filename).toBeTruthy()
    const installed = [{ name: main!.filename!, type: classifyModel(main!.filename!) }]
    expect(swapLocalModels(installed as never)).toHaveLength(1)
  })

  it('counter-check: the VACE bundle would not have unlocked it', () => {
    const vace = getMotionBundles()[0]
    const main = vace.files.find((f) => f.subfolder === 'diffusion_models')!
    expect(swapLocalModels([{ name: main.filename!, type: classifyModel(main.filename!) }] as never)).toHaveLength(0)
  })
})
