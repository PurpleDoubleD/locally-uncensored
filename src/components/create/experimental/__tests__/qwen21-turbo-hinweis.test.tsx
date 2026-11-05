// @vitest-environment jsdom
/**
 * Qwen-Image 2.1 Turbo on ComfyUI runs its own eight step schedule, so the
 * Quality section says which sliders do not reach it, and warns when CFG is
 * above the 1 the model is made for. Only for a Turbo file.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/qwen21-turbo-hinweis.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

import { ParamGroups } from '../ParamGroups'
import { useCreateStore } from '../../../../stores/createStore'
import { classifyModel } from '../../../../api/comfyui'

function setup(model: string, intent: 'image' | 'edit' = 'image') {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, transparentBackground: false, improvePrompt: false,
    cloudStudioOptions: {}, cloudOp: null, utilityOp: null, removebg: false, textEncoderList: [],
    imageModelList: [{ name: model, type: classifyModel(model) }],
  } as never)
  useCreateStore.getState().setImageModel(model, classifyModel(model))
  useCreateStore.getState().setIntent(intent)
}

const hint = () => screen.queryByTestId('qwen21-turbo-hint')

afterEach(() => { cleanup() })

describe('the Turbo line in Quality', () => {
  it.each([['image'], ['edit']] as const)('shows for a Turbo file on %s', (intent) => {
    setup('qwen_image_2.1_turbo_int8_convrot.safetensors', intent)
    render(<ParamGroups />)
    expect(hint()?.textContent).toBe('Turbo runs its own 8-step schedule at CFG 1. Steps, sampler and scheduler are not used.')
  })

  it('names a CFG above 1', () => {
    setup('qwen_image_2.1_turbo_bf16.safetensors')
    useCreateStore.setState({ cfgScale: 3 })
    render(<ParamGroups />)
    expect(hint()?.textContent).toContain('CFG 3.0 is above the 1 Turbo is made for')
  })

  it('COUNTER-CHECK: not for the full 2.1 model or another Turbo family', () => {
    for (const model of ['qwen_image_2.1_int8_convrot.safetensors', 'z_image_turbo_bf16.safetensors', 'sd_turbo.safetensors']) {
      setup(model)
      render(<ParamGroups />)
      expect(hint(), model).toBeNull()
      cleanup()
    }
  })
})
