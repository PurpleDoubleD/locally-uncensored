// @vitest-environment jsdom
/**
 * GH #161 (2026-10-12, Windows, 3.0.6): picking a Z Image character under
 * "Use character" left the Qwen image model selected.
 *
 * The pick now sets the model the character was trained for, warns where it
 * cannot, and says under the pick that the trigger word alone is not enough.
 * Since 3.1.0 part B the pick is step 1 of the Character area and Image its
 * action (hub/hubCharacters openHubAction); the panel says the rest.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/use-character-picks-its-base-model.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  backendCall: vi.fn(async () => ({ status: 'ok' })),
}))
vi.mock('../../../../api/comfyui', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/comfyui')>('../../../../api/comfyui')
  return { ...actual, getLoraModels: vi.fn(async () => ['char_mira_zimage.safetensors']) }
})
vi.mock('../../../../api/cloud/loras', () => ({ listLoras: vi.fn(async () => []), deleteLora: vi.fn() }))

import { SpecialControls } from '../SpecialIntentControls'
import { useCreateStore } from '../../../../stores/createStore'
import { classifyModel, type ClassifiedModel } from '../../../../api/comfyui'
import { openHubAction } from '../hub/hubCharacters'
import { hubFromLocal } from '../../../../lib/create/character-hub'
import { characterFromLora } from '../../../../lib/characters'

/** Step 1 picks mira, step 2 Image. */
async function pickMira() {
  await act(async () => { await openHubAction('image', hubFromLocal(characterFromLora('char_mira_zimage.safetensors')!)) })
}

const model = (name: string): ClassifiedModel => ({ name, type: classifyModel(name), source: 'diffusion_model' })
const QWEN = model('qwen_image_2512_fp8_e4m3fn.safetensors')
const BASE = model('z_image_bf16.safetensors')

function start(list: ClassifiedModel[]) {
  useCreateStore.setState({
    backend: 'local', mode: 'image', cloudOp: 'character', characterTab: 'use',
    imageModelList: list, imageModel: QWEN.name, imageModelType: QWEN.type,
    selectedLoras: [], selectedCharacter: null,
  })
  render(<SpecialControls intent="character" />)
}

beforeEach(() => cleanup())

describe('Use character', () => {
  it('the test stands on the character tab', () => {
    start([QWEN, BASE])
    expect(useCreateStore.getState().intent()).toBe('character')
  })

  it('picking a Z Image character under Qwen sets the Z Image model', async () => {
    start([QWEN, BASE])
    await pickMira()
    const s = useCreateStore.getState()
    expect([s.imageModel, s.imageModelType]).toEqual([BASE.name, 'zimage'])
    expect(s.selectedLoras.map((l) => l.name)).toEqual(['char_mira_zimage.safetensors'])
    expect(screen.queryByTestId('character-model-warning')).toBeNull()
    expect(screen.getByTestId('character-use-hint').textContent)
      .toBe('Put “mira” in your prompt and describe the key features too. The trigger word alone often does not hold the look.')
  })

  it('no Z Image model installed: the model stays and the panel warns', async () => {
    start([QWEN])
    await pickMira()
    expect(useCreateStore.getState().imageModel).toBe(QWEN.name)
    expect(screen.getByTestId('character-model-warning').textContent)
      .toBe('This character was trained for Z Image, and no Z Image model is installed. Get one in the Model Manager to use it.')
    expect(screen.queryByTestId('character-model-switch')).toBeNull()
  })

  it('the model changed after the pick: the panel warns and offers the way back', async () => {
    start([QWEN, BASE])
    await pickMira()
    act(() => { useCreateStore.getState().setImageModel(QWEN.name, QWEN.type) })
    const warning = await screen.findByTestId('character-model-warning')
    expect(warning.textContent).toContain('This character was trained for Z Image. Pick a Z Image model to use it.')
    fireEvent.click(screen.getByTestId('character-model-switch'))
    expect(useCreateStore.getState().imageModel).toBe(BASE.name)
  })
})
