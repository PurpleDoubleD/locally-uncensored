/**
 * GH #192 part 3 and C29: the image tool of the chat always built LU's own
 * graph and never asked which workflow the user had assigned to the model,
 * so a model that only runs with its own workflow (MOSS Image in the issue)
 * could not be used from the chat. It now takes the assigned workflow as
 * Create does, with the values set under "Workflow parameters", and sets it
 * aside by the same loader check when it does not fit the model.
 *
 * Run: npx vitest run src/api/__tests__/chat-image-uses-the-assigned-workflow.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ownWorkflowFor } from '../vram-handoff'
import { useWorkflowStore } from '../../stores/workflowStore'

const UNET_WF = {
  id: 'wf-moss', name: 'MOSS Image (own)',
  workflow: { '1': { class_type: 'UNETLoader', inputs: { unet_name: 'moss_image.safetensors' } }, '2': { class_type: 'KSampler', inputs: {} } },
  parameterMap: { model: { nodeId: '1', inputKey: 'unet_name' } },
}
const CKPT_WF = {
  ...UNET_WF, id: 'wf-ckpt', name: 'SDXL (own)',
  workflow: { '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } },
}

function assign(wf: unknown) {
  useWorkflowStore.setState({
    getWorkflowForModel: () => wf as ReturnType<ReturnType<typeof useWorkflowStore.getState>['getWorkflowForModel']>,
    paramOverrides: { 'wf-moss': { '2.steps': 50 } } as never,
  })
}

describe('#192 part 3: the chat image tool takes the workflow assigned to the model', () => {
  beforeEach(() => assign(null))

  it('a fitting assigned workflow is used, with the user\'s parameter values', async () => {
    assign(UNET_WF)
    const own = await ownWorkflowFor('moss_image.safetensors', 'unknown', 'diffusion_model')
    expect(own?.name).toBe('MOSS Image (own)')
    expect(own?.overrides).toEqual({ '2.steps': 50 })
  })

  it('one whose loader does not fit the model is set aside, as in Create', async () => {
    assign(CKPT_WF)
    expect(await ownWorkflowFor('moss_image.safetensors', 'unknown', 'diffusion_model')).toBeNull()
  })

  it('no assignment: LU builds its own graph as before', async () => {
    expect(await ownWorkflowFor('juggernautXL.safetensors', 'sdxl', 'checkpoint')).toBeNull()
  })

  it('the image path injects into the assigned workflow before it falls back to the builder', () => {
    const src = readFileSync(resolve(__dirname, '../vram-handoff.ts'), 'utf8')
    expect(src).toMatch(/const own = await ownWorkflowFor\(model, type, listed\?\.source\)\s+const workflow = own\s+\? await injectParameters\(own\.workflow, own\.parameterMap, params, type, own\.overrides\)\s+: await buildFixable\('image', \(\) => buildDynamicWorkflow\(params, type\)\)/)
  })
})
