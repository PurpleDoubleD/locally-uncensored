// @vitest-environment jsdom
/**
 * C8: the question "Replace character?" is on screen in Character › Train new
 * and its buttons answer the waiting run (stores/trainReplaceStore.ts).
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/train-replace-dialog.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../../../api/mlx-image', async (orig) => ({ ...(await orig<typeof import('../../../../api/mlx-image')>()), isMlxImageHost: () => true }))
vi.mock('../../../../api/mlx-train', async (orig) => ({
  ...(await orig<typeof import('../../../../api/mlx-train')>()),
  getMacTrainStatus: vi.fn(async () => ({ engineReady: true, base: 'z-image-turbo-4bit', adapterReady: true, adapterBytes: 1, minRamGB: 24, memoryRefusal: null, running: false })),
}))

import { SpecialControls } from '../SpecialIntentControls'
import { useCreateStore } from '../../../../stores/createStore'
import { useTrainReplaceStore } from '../../../../stores/trainReplaceStore'

afterEach(() => cleanup())

describe('C8: the replace question in Train new', () => {
  it.each([
    ['train-replace-confirm', 'replace'],
    ['train-replace-rename', 'rename'],
  ])('%s answers %s', async (button, expected) => {
    useCreateStore.setState({ backend: 'local', error: null, triggerWord: 'luxfox', trainImages: [] } as never)
    useCreateStore.getState().setIntent('character')
    useCreateStore.getState().setCharacterTab('train')
    render(<SpecialControls intent="character" />)
    let answer!: Promise<string>
    act(() => { answer = useTrainReplaceStore.getState().ask('luxfox') })
    expect((await screen.findByText(/already exists on this computer/)).textContent).toContain('luxfox')
    fireEvent.click(screen.getByTestId(button))
    await expect(answer).resolves.toBe(expected)
  })
})
