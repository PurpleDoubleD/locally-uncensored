// @vitest-environment jsdom
/**
 * Two lines of the Mac's Create that spoke of another machine (how-it-works
 * film, 15.10.2026): the model chip of the Train tab named the picked image
 * model ("MLX SD Turbo") while the Mac trains on Z-Image Turbo, and the
 * Talking Character hint asked for a clip a Mac cannot resync.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const host = vi.hoisted(() => ({ mac: true }))
vi.mock('../../../../api/mlx-image', async (orig) => ({ ...(await orig<typeof import('../../../../api/mlx-image')>()), isMlxImageHost: () => host.mac }))

import { ModelChip } from '../ModelChip'
import { noPromptHint } from '../laneHint'
import { useCreateStore } from '../../../../stores/createStore'

function arrange(tab: 'use' | 'train') {
  useCreateStore.setState({
    backend: 'local',
    imageModelList: [{ name: 'MLX SD Turbo', type: 'sd15', source: 'checkpoint' }],
  } as never)
  const s = useCreateStore.getState()
  s.setImageModel('MLX SD Turbo', 'sd15')
  s.setIntent('character')
  s.setCharacterTab(tab)
}

afterEach(() => { cleanup(); host.mac = true })

describe('the Train tab on a Mac', () => {
  it('names the model a character trains on, not the picked image model', () => {
    arrange('train')
    render(<ModelChip />)
    expect(screen.getByTestId('mac-train-base').textContent).toBe('Trains on Z-Image Turbo')
    expect(screen.queryByText('MLX SD Turbo')).toBeNull()
  })

  it('COUNTER-CHECK: Use character keeps the picker', () => {
    arrange('use')
    render(<ModelChip />)
    expect(screen.queryByTestId('mac-train-base')).toBeNull()
    expect(screen.queryByTestId('local-train-base')).toBeNull()
  })

  // GH #210: Windows and Linux showed the picker on Train, and a pick there
  // read as the training model. Their trainer is Z-Image Base alone.
  it('Windows and Linux: Train names Z-Image instead of offering a model', () => {
    host.mac = false
    arrange('train')
    render(<ModelChip />)
    expect(screen.queryByTestId('mac-train-base')).toBeNull()
    expect(screen.getByTestId('local-train-base').textContent).toBe('Local training uses Z-Image')
    expect(screen.queryByText('MLX SD Turbo')).toBeNull()
    cleanup()
    arrange('use')
    render(<ModelChip />)
    expect(screen.queryByTestId('local-train-base')).toBeNull()
  })
})

describe('the Talking Character hint', () => {
  it('asks a Mac for a portrait and a voice, never for a clip', () => {
    expect(noPromptHint('lipsync', 'local', true)).toBe('Add a portrait and a voice recording above, then hit Create to make it speak.')
    expect(noPromptHint('lipsync', 'local', true)).not.toMatch(/clip/)
  })

  it('COUNTER-CHECK: elsewhere a clip to resync is still offered', () => {
    expect(noPromptHint('lipsync')).toContain('(or clip)')
  })
})
