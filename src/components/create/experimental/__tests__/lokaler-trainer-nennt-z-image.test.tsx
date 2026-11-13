// @vitest-environment jsdom
/**
 * GH #210 (31.10.2026, Linux Mint, RX 9070 XT, 3.0.8): with Qwen-Image 2.1
 * picked, Train new made a Z-Image LoRA, and the tester read that as the wrong
 * model trained. The local trainer trains on Z-Image Base alone (musubi, the
 * three TRAINER_BASE_FILES); the picked image model never reaches it. Nothing
 * said so before the run. Now a line under the trainer does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => false,
  isLinux: () => true,
  backendCall: vi.fn(async () => ({ status: 'ok' })),
}))
vi.mock('../../../../api/trainer', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/trainer')>('../../../../api/trainer')
  return {
    ...actual,
    characterTrainerStatus: vi.fn(async () => ({
      envReady: true, basesReady: true, root: '/data/lu/musubi', customized: false, suggestedRoot: null,
      install: { status: 'done', step: '', percent: 100 },
    })),
    installCharacterTrainer: vi.fn(async () => undefined),
  }
})
vi.mock('../../../../api/comfyui', () => ({ getLoraModels: vi.fn(async () => []), getSystemVRAM: vi.fn(async () => null) }))
vi.mock('../../../../hooks/useGraphicsMemory', () => ({ useGraphicsCardGb: () => 16 }))
vi.mock('../../../../api/cloud/loras', () => ({ listLoras: vi.fn(async () => []), deleteLora: vi.fn() }))

import { SpecialControls } from '../SpecialIntentControls'
import { useCreateStore } from '../../../../stores/createStore'

beforeEach(() => {
  cleanup()
  useCreateStore.setState({ backend: 'local', characterTab: 'train', trainKind: 'character', imageModel: 'qwen_image_2.1_fp8.safetensors' } as never)
})

describe('the local trainer says which model it trains', () => {
  it('with Qwen-Image 2.1 picked, the line says the character comes out for Z-Image', async () => {
    render(<SpecialControls intent="character" />)
    const line = await screen.findByTestId('local-train-family-note')
    expect(line.textContent).toBe('The local trainer makes a Z-Image character, whatever image model is picked. Use it with a Z-Image model.')
  })

  it('in style mode it says style', async () => {
    render(<SpecialControls intent="character" />)
    await screen.findByTestId('local-train-family-note')
    fireEvent.click(screen.getByRole('radio', { name: 'Style / concept' }))
    expect(screen.getByTestId('local-train-family-note').textContent).toContain('makes a Z-Image style')
  })

  it('the training call carries no model: Z-Image is the trainer itself, not a lost choice', () => {
    const api = readFileSync(resolve(__dirname, '../../../../api/trainer.ts'), 'utf8')
    expect(api).toContain("backendCall('start_character_training', { setId, name, triggerWord, steps: steps ?? null, preset: preset ?? null, kind: kind ?? null })")
  })
})
