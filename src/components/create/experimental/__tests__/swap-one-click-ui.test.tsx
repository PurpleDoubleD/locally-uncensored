// @vitest-environment jsdom
/**
 * One click swap in the Character area (only with the account switch; port
 * of the web's swap-one-click-ui.test.tsx, 4e121fc0): ONE button with the
 * total (frame + video), one press runs the chain, a refusal of the frame
 * step shows the quiet sentence and books no video, the consent is a must,
 * and without the switch the area keeps the old panel. The button is the one
 * of the prompt window under the area (the Composer), not a bar of its own.
 * Every way to the server is a fake, the catalogue a fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent, renderHook } from '@testing-library/react'

const QUOTA = {
  tier: 'pro', period: 'month', limits: { credits: 10_000_000 }, costs: { image: 1000, video: 10000 },
  used: { credits_used: 0 }, remaining: { credits: 10_000_000 },
}
const refreshQuota = vi.fn(async () => {})
const generate = vi.fn(async () => {})
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate, cancel: vi.fn(), makeVoice: vi.fn(), quota: QUOTA, refreshQuota,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../useStudioPrice', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  mediaSeconds: async () => 6,
  useStudioPrice: (model: string | undefined) => (model ? { credits: 48000, live: false } : null),
}))
const built = vi.hoisted(() => ({ models: [] as string[] }))
vi.mock('../../../../hooks/useCloudCreate', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  buildSwapVideoSubmit: vi.fn(async (model: string) => {
    built.models.push(model)
    return { kind: 'video', model, prompt: '', params: { op: 'studio', video_path: 'u/v', swap_step: 'video', swap_consent: true, sound: 'original', max_credits: 48000 } }
  }),
}))
const cloud = vi.hoisted(() => {
  const submits: { kind: string; model: string; params: Record<string, unknown> }[] = []
  const state = { refuse: false }
  return {
    submits,
    state,
    uploadInput: vi.fn(async () => 'u/x'),
    adoptInput: vi.fn(async () => 'a/x'),
    submitCloudJob: vi.fn(async (s: { kind: string; model: string; params: Record<string, unknown> }) => { submits.push(s); return { id: `job-${submits.length}` } }),
    pollJob: vi.fn(async (id: string) => (state.refuse
      ? { id, kind: 'image', model: 'nano-banana-pro-edit', status: 'failed', error: 'Nano Banana Pro declined this prompt.', fallback_model: 'qwen-image-2.1-edit', result_url: null }
      : { id, kind: id === 'job-1' ? 'image' : 'video', model: 'x', status: 'succeeded', result_url: `https://r/${id}`, error: null, attestation: null })),
    cancelJob: vi.fn(async () => {}),
  }
})
vi.mock('../../../../api/cloud/jobs', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  uploadInput: cloud.uploadInput, adoptInput: cloud.adoptInput, submitCloudJob: cloud.submitCloudJob,
  pollJob: cloud.pollJob, cancelJob: cloud.cancelJob,
}))

import { SwapOneClick, useSwapOneClickShown } from '../hub/SwapOneClick'
import { Composer } from '../Composer'
import { useCreateStore } from '../../../../stores/createStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { useCharacterHubReleaseStore } from '../../../../lib/create/character-hub-release'
import { neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'
import { clearSwapChain, swapChainStore } from '../../../../lib/create/swap-chain'
import { useSwapOneClick } from '../../../../lib/create/swap-one-click'
import { SWAP_CONSENT_TEXT } from '../../../../lib/render/swap'

const PIXEL = 'data:image/jpeg;base64,/9j/4AAQ'
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)) })

// The flow and the prompt window under it: the button is the window's.
function Panel() {
  return (
    <>
      <div className="lu-hub flex flex-col"><SwapOneClick onChangeCharacter={() => {}} /></div>
      <Composer hub onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />
    </>
  )
}

const createButton = () => screen.getByRole('button', { name: /^Create/ }) as HTMLButtonElement

beforeEach(() => {
  cloud.submits.length = 0
  cloud.state.refuse = false
  built.models.length = 0
  generate.mockClear()
  cloud.uploadInput.mockClear()
  clearSwapChain()
  localStorage.clear()
  useCharacterHubReleaseStore.setState({ fromMe: true, fromCatalog: null })
  useCloudCatalogStore.setState({ models: neuerServer() })
  useSwapOneClick.setState({ openModels: false, check: false, checkTouched: false, frameOverride: '', videoOverride: '' })
  useCreateStore.setState({
    isGenerating: false, batchRun: null, error: null, gallery: [], source: null, prompt: '',
    backend: 'cloud', cloudStudioOptions: {}, cloudStudioCredits: null, cloudOpModel: '',
    sound: 'original', audioInput: null, voiceFromJob: null, lipsyncCredits: null,
  } as never)
  useCreateStore.getState().setIntent('swap_character')
  useCreateStore.setState({
    videoInput: { name: 'clip.mp4', url: 'blob:clip', blob: new Blob(['v']) },
    swapFrame: { url: PIXEL, width: 1280, height: 720, videoUrl: 'blob:clip' },
    swapFigures: [
      { image: { filename: 'b', url: PIXEL, width: 1, height: 1 }, role: '', mark: { x: 0.4, y: 0.3 }, character: 'Bean' },
      { image: { filename: 's', url: PIXEL, width: 1, height: 1 }, role: '', mark: { x: 0.7, y: 0.3 } },
    ],
    swapSeconds: null, swapBuilt: null,
    swapConsent: true,
  })
})
afterEach(() => { cleanup() })

describe('one button, one price', () => {
  it('Create shows frame + video (62k) and runs the frame, then the video', async () => {
    render(<Panel />)
    await flush()
    const button = createButton()
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Create · 62k')
    expect(document.querySelector('[data-clip-split]')!.textContent).toBe('frame 14k + video 48k')
    expect(document.querySelector('[data-swap-summary]')!.textContent).toBe('Auto · SCAIL-2 · 720p')
    // The engine stands in the store, the video price is the ceiling.
    expect(useCreateStore.getState().cloudOpModel).toBe('scail-2')
    expect(useCreateStore.getState().cloudStudioCredits).toBe(48000)
    fireEvent.click(button)
    await flush()
    expect(built.models).toEqual(['scail-2'])
    expect(cloud.submits.map((s) => [s.model, s.params.swap_step, s.params.swap_consent])).toEqual([
      ['nano-banana-pro-edit', 'frame', true], ['scail-2', 'video', true],
    ])
    expect(cloud.submits[1].params.source_path).toBe('a/x')
    expect(document.querySelector('[data-swap-one-click=done]')).toBeTruthy()
    expect(screen.getByText(/Your new video · Bean and Photo/)).toBeTruthy()
    // The result is in the gallery under the swap's name.
    expect(useCreateStore.getState().gallery.some((g) => g.label === 'Swap Character')).toBe(true)
  })

  it('a refusal starts and books no video and offers Uncensored', async () => {
    cloud.state.refuse = true
    render(<Panel />)
    await flush()
    fireEvent.click(createButton())
    await flush()
    expect(cloud.submits.map((s) => s.params.swap_step)).toEqual(['frame'])
    expect(screen.getByText(/refused this image\. Nothing was charged, and the video was not started\./)).toBeTruthy()
    expect(screen.getByText('Change character')).toBeTruthy()
    cloud.state.refuse = false
    fireEvent.click(screen.getByText('Turn on Uncensored and retry'))
    await flush()
    expect(cloud.submits[1].model).toBe('qwen-image-2.1-edit')
    expect(useSwapOneClick.getState().openModels).toBe(true)
    // Uncensored turns the check on: the open frame waits for Continue.
    expect(document.querySelector('[data-swap-one-click=review]')).toBeTruthy()
    expect(cloud.submits).toHaveLength(2)
  })

  it('with Uncensored the frame runs on the open editor, and the price follows', async () => {
    useSwapOneClick.setState({ openModels: true })
    render(<Panel />)
    await flush()
    fireEvent.click(createButton())
    await flush()
    expect(cloud.submits[0].model).toBe('qwen-image-2.1-edit')
    expect(cloud.submits[0].params.swap_step).toBe('frame')
  })

  it('Check first frame stops after the frame; Continue starts the video', async () => {
    render(<Panel />)
    await flush()
    fireEvent.click(screen.getByRole('switch', { name: 'Check first frame before video' }))
    expect(useSwapOneClick.getState().check).toBe(true)
    fireEvent.click(createButton())
    await flush()
    expect(document.querySelector('[data-swap-one-click=review]')).toBeTruthy()
    expect(cloud.submits).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }))
    await flush()
    expect(cloud.submits.map((s) => s.params.swap_step)).toEqual(['frame', 'video'])
  })

  it('turning Uncensored on turns the check on; after Uncensored the chain stops for the check', async () => {
    render(<Panel />)
    await flush()
    const check = () => screen.getByRole('switch', { name: 'Check first frame before video' }).getAttribute('aria-checked')
    fireEvent.click(screen.getByRole('switch', { name: 'Uncensored' }))
    expect(check()).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: 'Uncensored' }))
    expect(check()).toBe('false')
    fireEvent.click(screen.getByRole('switch', { name: 'Uncensored' }))
    fireEvent.click(createButton())
    await flush()
    expect(cloud.submits.map((s) => s.model)).toEqual(['qwen-image-2.1-edit'])
    expect(document.querySelector('[data-swap-one-click=review]')).toBeTruthy()
  })

  it('a check set by hand no longer follows Uncensored', async () => {
    render(<Panel />)
    await flush()
    fireEvent.click(screen.getByRole('switch', { name: 'Uncensored' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Check first frame before video' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Uncensored' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Uncensored' }))
    expect(screen.getByRole('switch', { name: 'Check first frame before video' }).getAttribute('aria-checked')).toBe('false')
  })

  it('both switches stand in the panel, both off', async () => {
    render(<Panel />)
    await flush()
    const open = screen.getByRole('switch', { name: 'Uncensored' })
    expect(open.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Off: Nano Banana Pro + SCAIL-2. On: open-weight models, less strict.')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Check first frame before video' }).getAttribute('aria-checked')).toBe('false')
  })
})

describe('one window', () => {
  it('has no bar of its own: Create, Cancel and Continue are the prompt window\'s', async () => {
    render(<Panel />)
    await flush()
    expect(document.querySelector('[data-swap-bar]')).toBeNull()
    expect(document.querySelector('.hub-bar')).toBeNull()
    const win = document.querySelector('[data-prompt-window]')!
    expect(win.contains(createButton())).toBe(true)
    expect(screen.getAllByRole('button', { name: /^Create/ })).toHaveLength(1)
    // The video can come in through the window as well.
    expect(win.querySelector('[data-hub-upload]')).toBeTruthy()
  })

  it('the check of the first frame asks in the window\'s field, Try again stands under the pictures', async () => {
    render(<Panel />)
    await flush()
    fireEvent.click(screen.getByRole('switch', { name: 'Check first frame before video' }))
    fireEvent.click(createButton())
    await flush()
    const win = document.querySelector('[data-prompt-window]')!
    const field = win.querySelector('textarea')!
    expect(field.getAttribute('placeholder')).toBe("What's wrong? (optional)")
    expect(win.contains(screen.getByRole('button', { name: /^Continue · 48k/ }))).toBe(true)
    fireEvent.change(field, { target: { value: 'wrong hair' } })
    fireEvent.click(document.querySelector('[data-swap-retry]')!)
    await flush()
    expect(cloud.submits.map((s) => s.params.swap_step)).toEqual(['frame', 'frame'])
    expect(JSON.stringify(cloud.submits[1])).toContain('wrong hair')
  })
})

describe('the gates', () => {
  it('without the consent the button stays off and nothing goes up', async () => {
    useCreateStore.setState({ swapConsent: false })
    render(<Panel />)
    await flush()
    expect(screen.getByText(SWAP_CONSENT_TEXT)).toBeTruthy()
    expect(createButton().disabled).toBe(true)
    fireEvent.click(createButton())
    await flush()
    expect(cloud.submits).toHaveLength(0)
    expect(cloud.uploadInput).not.toHaveBeenCalled()
  })

  it('without a character for a mark the button stays off', async () => {
    useCreateStore.setState({ swapFigures: [{ image: null, role: '', mark: { x: 0.5, y: 0.5 } }] })
    render(<Panel />)
    await flush()
    expect(createButton().disabled).toBe(true)
  })

  it('four people: OpenJutsu in one step through the normal Create run, no chain', async () => {
    const fig = { image: { filename: 'p', url: PIXEL, width: 1, height: 1 }, role: '', mark: { x: 0.5, y: 0.5 } }
    useCreateStore.setState({ swapFigures: [fig, fig, fig, fig] })
    render(<Panel />)
    await flush()
    expect(useCreateStore.getState().cloudOpModel).toBe('openjutsu-character-swap')
    expect(screen.queryByRole('switch', { name: 'Uncensored' })).toBeNull()
    fireEvent.click(createButton())
    await flush()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(cloud.submits).toHaveLength(0)
    expect(swapChainStore.getState().chain).toBeNull()
  })

  it('the area shows it only with the account switch and on the cloud', () => {
    expect(renderHook(() => useSwapOneClickShown()).result.current).toBe(true)
    useCharacterHubReleaseStore.setState({ fromMe: false, fromCatalog: null })
    expect(renderHook(() => useSwapOneClickShown()).result.current).toBe(false)
    useCharacterHubReleaseStore.setState({ fromMe: true, fromCatalog: null })
    useCreateStore.setState({ backend: 'local' })
    expect(renderHook(() => useSwapOneClickShown()).result.current).toBe(false)
  })

  it('without the switch the panel says Coming soon and has no Create', async () => {
    useCharacterHubReleaseStore.setState({ fromMe: false, fromCatalog: null })
    render(<Panel />)
    await flush()
    expect(screen.getByText(/Coming soon to your LU Cloud/)).toBeTruthy()
    expect(createButton().disabled).toBe(true)
  })
})
