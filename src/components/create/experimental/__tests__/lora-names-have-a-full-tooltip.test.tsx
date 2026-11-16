// @vitest-environment jsdom
/**
 * GitHub discussion #150: long LoRA names were cut off in Create, so LoRAs
 * that start alike could not be told apart. The stack in the advanced
 * settings shows the whole name (e2e/lora-names-read-in-full.spec.ts). The two
 * places that keep one line carry the whole name as their tooltip: the style
 * LoRA field of a Studio model and the character row of the Character area.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/lora-names-have-a-full-tooltip.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const LONG_A = 'cinematic_film_grain_photoreal_portrait_lighting_xl_v2_epoch_08_rank32'
const LONG_B = 'cinematic_film_grain_photoreal_portrait_lighting_xl_v2_epoch_12_rank64'

vi.mock('../../../../api/comfyui', () => ({ getLoraModels: vi.fn(async () => []) }))
vi.mock('../../../../api/cloud/loras', () => ({
  listLoras: vi.fn(async () => [
    { id: 'c1', name: 'Grace in the red coat, studio set, second training run', trigger_word: 'gracechar', base_family: 'z-image', created_at: '2026-10-01T00:00:00Z' },
  ]),
  deleteLora: vi.fn(),
  downloadLora: vi.fn(),
}))

import { SchemaControl } from '../SchemaControl'
import { HubTabs } from '../hub/HubStage'
import { hubFromCloud } from '../../../../lib/create/character-hub'
import { listLoras } from '../../../../api/cloud/loras'

afterEach(cleanup)

describe('LoRA names that keep one line', () => {
  it('the style LoRA field of a Studio model names the picked LoRA in full as its tooltip', () => {
    const schema = { type: 'array', maxItems: 3, items: { properties: { path: { enum: [LONG_A, LONG_B] } } } }
    render(<SchemaControl name="loras" schema={schema as never} value={[{ path: LONG_B, scale: 1 }]} onChange={() => {}} disabled={false} />)
    expect(screen.getByLabelText('LoRA 1').getAttribute('title')).toBe(LONG_B)
  })

  it('a character row names the character in full as its tooltip, next to the trigger word', async () => {
    // Since 3.1.0 part B the characters are the tabs of the stage of the
    // Character area; a long name is cut there as it was on the chip.
    const list = (await listLoras()).map(hubFromCloud)
    render(<div className="lu-hub"><HubTabs list={list} loading={false} current={null} photoOnly={false} onPick={() => {}} onPhotoOnly={() => {}} onNew={() => {}} /></div>)
    const row = await screen.findByRole('tab', { name: /Grace in the red coat/ })
    expect(row.getAttribute('title')).toBe('Grace in the red coat, studio set, second training run, trigger word: gracechar')
  })
})
