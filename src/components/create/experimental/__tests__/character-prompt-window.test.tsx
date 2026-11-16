// @vitest-environment jsdom
/**
 * David, 16.11.2026: the prompt window is the same in every tab of Create,
 * the Character tab included. The same Composer, 660 wide, centred, at the
 * foot, with the same least height. In it only the text field, Create, one
 * settings icon and at most an upload. The tab's own choice (Image, Swap,
 * Motion, Talk) is a row over the window, where the other tabs have theirs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

const generate = vi.fn()
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate, cancel: vi.fn(), makeVoice: vi.fn(), quota: null,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/mlx-image', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  isMlxImageHost: () => false,
}))

import { Composer } from '../Composer'
import { useCreateStore, type CreateIntent } from '../../../../stores/createStore'
import { useHubRun } from '../hub/hubRun'

const area = () => document.querySelector('[data-prompt-window-area]') as HTMLElement
const column = () => area().firstElementChild as HTMLElement
const win = () => document.querySelector('[data-prompt-window]') as HTMLElement
const shape = () => [area().className, column().className, win().className]
const open = (intent: CreateIntent, hub: boolean) => {
  useCreateStore.getState().setIntent(intent)
  if (intent === 'character') useCreateStore.getState().setCharacterTab('use')
  return render(<Composer hub={hub} onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
}

beforeEach(() => {
  generate.mockClear()
  useHubRun.setState({ stage: null, swap: null })
  useCreateStore.setState({
    backend: 'local', isGenerating: false, batchRun: null, error: null, gallery: [], source: null, prompt: '',
    selectedCharacter: null, videoInput: null, audioInput: null,
  } as never)
})
afterEach(cleanup)

describe('the prompt window of the Character tab', () => {
  it('is built as on Image: the same wrapper, the same 660 column, the same frame', () => {
    open('image', false)
    const image = shape()
    cleanup()
    const seen: string[][] = []
    for (const intent of ['character', 'swap_character', 'motion', 'lipsync'] as CreateIntent[]) {
      open(intent, true)
      seen.push(shape())
      cleanup()
    }
    for (const s of seen) expect(s).toEqual(image)
    expect(image[0]).toContain('min-h-[192px]')
    expect(image[1]).toContain('max-w-[660px]')
    expect(image[1]).toContain('mx-auto')
  })

  it('the text field stands on every action; where the action takes no text it says so', () => {
    open('character', true)
    const field = win().querySelector('textarea')!
    expect(field.disabled).toBe(false)
    cleanup()
    useCreateStore.setState({ backend: 'cloud' } as never)
    open('swap_character', true)
    const swap = win().querySelector('textarea')!
    expect(swap.disabled).toBe(true)
    expect(swap.getAttribute('placeholder')).toBe('Swap needs no text.')
  })

  it('holds only the field, the settings icon and Create, and an upload where the action takes a video', () => {
    open('character', true)
    expect([...win().querySelectorAll('button')].map((b) => b.getAttribute('title') ?? b.textContent)).toEqual(['Advanced settings', 'Create'])
    cleanup()
    open('motion', true)
    expect([...win().querySelectorAll('button')].map((b) => b.getAttribute('title') ?? b.textContent)).toEqual(['Upload the video', 'Advanced settings', 'Create'])
    const file = new File(['v'], 'dance.mp4', { type: 'video/mp4' })
    fireEvent.change(win().querySelector('[data-hub-upload]')!, { target: { files: [file] } })
    expect(useCreateStore.getState().videoInput?.name).toBe('dance.mp4')
  })

  it('the row of the tab stands over the window, in the same column, with Image picked', () => {
    open('character', true)
    const row = screen.getByRole('radiogroup', { name: 'Character action' })
    expect(column().contains(row)).toBe(true)
    expect(row.compareDocumentPosition(win()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(win().contains(row)).toBe(false)
    expect(row.querySelector('[data-hub-action="image"]')!.getAttribute('aria-checked')).toBe('true')
    cleanup()
    // The other tabs have no such row.
    open('image', false)
    expect(screen.queryByRole('radiogroup', { name: 'Character action' })).toBeNull()
  })

  it('the stage says what the button does where the tab\'s own run cannot start', () => {
    useHubRun.setState({ stage: { run: { label: 'Create', ready: false, hint: 'Create a character first.', run: () => {} } } })
    open('character', true)
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('lane-input-note').textContent).toBe('Create a character first.')
    cleanup()
    const run = vi.fn()
    useHubRun.setState({ stage: { placeholder: 'Describe a new picture of Mira', run: { label: 'Continue in Edit', ready: true, run } } })
    open('character', true)
    expect(win().querySelector('textarea')!.getAttribute('placeholder')).toBe('Describe a new picture of Mira')
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Edit' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(generate).not.toHaveBeenCalled()
  })

  it('outside the Character tab nothing of the area reaches the window', () => {
    useHubRun.setState({ stage: { run: { label: 'Continue in Edit', ready: true, run: () => {} } } })
    open('image', false)
    expect(screen.queryByRole('button', { name: 'Continue in Edit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()
  })
})
