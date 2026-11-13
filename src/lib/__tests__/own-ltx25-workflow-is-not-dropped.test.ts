/**
 * GitHub #196 (P5, 3.0.9): with an LTX 2.5 model picked, LU set the user's own
 * workflow aside before it ever reached injectParameters, because LTX 2.5 was
 * not on a fixed list of UNETLoader families. The Comfy-Org template loads its
 * transformer with UNETLoader, so LU rendered its own graph instead, silently.
 *
 * Run: npx vitest run src/lib/__tests__/own-ltx25-workflow-is-not-dropped.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { modelNeedsUnetLoader, ownWorkflowMisfit } from '../own-workflow-fit'

const template = JSON.parse(readFileSync(join(__dirname, '../../api/__tests__/fixtures/comfy-ui/templates/video_ltx2_5_i2v.json'), 'utf8')) as { nodes?: { type: string }[]; definitions?: { subgraphs?: { nodes?: { type: string }[] }[] } }
const templateTypes = [
  ...(template.nodes ?? []).map((n) => n.type),
  ...(template.definitions?.subgraphs ?? []).flatMap((g) => (g.nodes ?? []).map((n) => n.type)),
]

describe('an own workflow with a UNETLoader and an LTX 2.5 model', () => {
  it('the Comfy-Org template loads its model with UNETLoader', () => {
    expect(templateTypes).toContain('UNETLoader')
    expect(templateTypes).not.toContain('CheckpointLoaderSimple')
  })

  it('fits an LTX 2.5 model from the list (diffusion_models)', () => {
    expect(ownWorkflowMisfit(templateTypes, 'ltx25', 'diffusion_model')).toBeNull()
  })

  it('fits an LTX 2.5 model no list holds', () => {
    expect(ownWorkflowMisfit(templateTypes, 'ltx25')).toBeNull()
  })

  it('the folder decides over the family', () => {
    expect(modelNeedsUnetLoader('sdxl', 'diffusion_model')).toBe(true)
    expect(modelNeedsUnetLoader('flux', 'checkpoint')).toBe(false)
  })

  it('a wrong loader is still set aside', () => {
    expect(ownWorkflowMisfit(['CheckpointLoaderSimple', 'KSampler'], 'ltx25', 'diffusion_model')).toMatch(/needs UNETLoader/)
    expect(ownWorkflowMisfit(['UNETLoader', 'KSampler'], 'sdxl', 'checkpoint')).toMatch(/needs CheckpointLoaderSimple/)
  })
})
