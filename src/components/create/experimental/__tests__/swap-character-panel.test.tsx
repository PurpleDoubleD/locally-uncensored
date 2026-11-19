// @vitest-environment jsdom
/**
 * Swap Character on the desktop (07.11.2026, port of the web's C52; two steps
 * with SCAIL 2 and Kling since 14.11.2026; in the Character area since part B,
 * sketches v2): the panel (notes and video, first frame, people, sound,
 * consent, frame step), More options (resolution), the bar at the foot
 * (model, length, price, Create), the marks, the model picker, and Create
 * only once the video, a photo
 * for every person, the consent and (SCAIL 2, Kling) the confirmed first
 * frame are there. Nothing is rendered or booked: the Composer's generate and
 * the cloud calls of the frame step are fakes, the catalogue a fixture.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/swap-character-panel.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'

const QUOTA = {
  tier: 'pro', period: 'month', limits: { credits: 10_000_000 }, costs: { image: 1000, video: 10000 },
  used: { credits_used: 0 }, remaining: { credits: 10_000_000 },
}
const refreshQuota = vi.fn(async () => {})

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: QUOTA, refreshQuota,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openExternal: vi.fn(),
}))
// The frame step: never a real run, every cloud call a fake.
const cloud = vi.hoisted(() => ({
  uploadInput: vi.fn(async (_b: Blob, role: string) => `u/${role}-${Math.random().toString(36).slice(2, 6)}`),
  submitCloudJob: vi.fn(async (_s: unknown) => ({ id: 'bild-1', quota: { cost: 14000 } })),
  pollJob: vi.fn(async (id: string) => ({ id, status: 'succeeded', result_url: 'https://ours.example/bild.jpg' })),
  cancelJob: vi.fn(async () => ({ status: 'canceled' })),
}))
vi.mock('../../../../api/cloud/jobs', async (orig) => ({ ...((await orig()) as Record<string, unknown>), ...cloud }))
// jsdom plays no video: the length the WebView would measure.
const videoLength = vi.hoisted(() => ({ seconds: undefined as number | undefined }))
vi.mock('../useStudioPrice', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  mediaSeconds: async () => videoLength.seconds,
}))

import { Composer } from '../Composer'
import { SwapStage } from '../SwapStage'
import { SpecialControls } from '../SpecialIntentControls'
import { HubSettings } from '../hub/HubSettings'
import { ModelChip } from '../ModelChip'
import { useCharacterHubReleaseStore } from '../../../../lib/create/character-hub-release'
import { useCreateStore } from '../../../../stores/createStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'
import { SWAP_CONSENT_TEXT, SWAP_OPENJUTSU_MODEL, SWAP_TIPS, swapClipLimits } from '../../../../lib/render/swap'

const photo = { filename: 'face.png', url: 'data:image/png;base64,AA', width: 512, height: 768 }
const clip = { blob: new Blob(['x'], { type: 'video/mp4' }), name: 'dance.mp4', url: 'blob:dance' }
const FRAME = { url: 'data:image/jpeg;base64,eA==', width: 1080, height: 1920, videoUrl: 'blob:dance' }

beforeEach(() => {
  // An account the server released the Character area for (features.characterHub).
  useCharacterHubReleaseStore.setState({ fromMe: true, fromCatalog: null })
  for (const f of Object.values(cloud)) f.mockClear()
  videoLength.seconds = undefined
  useCloudCatalogStore.setState({ models: neuerServer() })
  useCreateStore.setState({
    isGenerating: false, batchRun: null, error: null, gallery: [], source: null, videoInput: null, prompt: '',
    backend: 'cloud', cloudStudioOptions: {}, cloudStudioCredits: null,
    // No pick of an earlier test: the tab resolves to its first model.
    cloudOpModel: '',
  } as never)
  useCreateStore.getState().setIntent('swap_character')
  useCreateStore.setState({ swapFigures: [{ image: null, role: '' }], swapSeconds: null, swapConsent: false, swapBuilt: null, swapFrame: null })
})
afterEach(() => cleanup())

/** The panel of the Character area: the inputs, the settings of the prompt
 *  window (open here: length, price, resolution, engines), and the window. */
function Panel() {
  const intent = useCreateStore((s) => s.intent())
  return (
    <div className="lu-hub">
      <SpecialControls intent={intent} />
      <HubSettings />
      <Composer hub onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />
    </div>
  )
}
function open() {
  return render(<Panel />)
}
/** The credits of the bar's price, from its title ("62,000 credits"). */
const total = () => document.querySelector('[data-clip-price]')?.getAttribute('title')
const split = () => document.querySelector('[data-clip-split]')?.textContent
const lengthButton = () => screen.getByRole('button', { name: 'Length' })
const create = () => screen.getByRole('button', { name: /^Create/ }) as HTMLButtonElement
const panel = () => document.querySelector('[data-swap-controls]') as HTMLElement

describe('the Swap Character panel', () => {
  it('stands in the order of the sketch: notes and video, people, sound, consent, frame step; no prompt field; SCAIL 2 at 720p', () => {
    open()
    expect(panel()).toBeTruthy()
    // The window's field stands and takes no text here.
    expect((document.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true)
    const order = ['[data-swap-tips]', '[data-swap-figures]', '[data-sound-controls]', '[data-swap-consent]', '[data-swap-built]']
      .map((sel) => panel().querySelector(sel) as HTMLElement)
    for (const el of order) expect(el).toBeTruthy()
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    // The notes, one line each, grey and not a warning.
    const tips = panel().querySelector('[data-swap-tips]') as HTMLElement
    expect([...tips.querySelectorAll('li')].map((li) => li.textContent)).toEqual([...SWAP_TIPS])
    expect(tips.className).toMatch(/hub-dim/)
    expect(tips.className).not.toMatch(/amber|yellow/)
    expect(screen.getByText('Add the original video')).toBeTruthy()
    expect(screen.getByText(SWAP_CONSENT_TEXT)).toBeTruthy()
    // SCAIL 2 is the default, preset to 720p in the store.
    const res = screen.getByRole('radiogroup', { name: 'Resolution' })
    expect([...res.querySelectorAll('[role=radio]')].map((b) => b.textContent)).toEqual(['480p', '720p'])
    expect(res.querySelector('[aria-checked=true]')?.textContent).toBe('720p')
    expect(useCreateStore.getState().cloudStudioOptions.resolution).toBe('720p')
    // Length and price stand in the settings once there is a video to measure.
    expect(screen.queryByRole('button', { name: 'Length' })).toBeNull()
    expect(document.querySelector('[data-clip-price]')).toBeNull()
    expect(swapClipLimits('scail-2').max).toBeGreaterThanOrEqual(15)
  })

  it('OpenJutsu: adds people up to four, each with a photo field and a place', () => {
    useCreateStore.getState().setCloudOpModel(SWAP_OPENJUTSU_MODEL)
    open()
    const add = () => screen.getByRole('button', { name: /Add person/ }) as HTMLButtonElement
    expect(add().textContent).toBe('+ Add person (1/4)')
    fireEvent.click(add())
    fireEvent.click(add())
    fireEvent.click(add())
    expect(useCreateStore.getState().swapFigures).toHaveLength(4)
    expect(add().textContent).toBe('+ Add person (4/4)')
    expect(add().disabled).toBe(true)
    fireEvent.click(add())
    expect(useCreateStore.getState().swapFigures).toHaveLength(4)
    for (let i = 1; i <= 4; i++) {
      expect(screen.getByRole('button', { name: `Character for person ${i}` })).toBeTruthy()
      // The one people rule: number, place, character. Without a tap the
      // place is a pick ("comes in later from the left/right").
      expect(screen.getByRole('button', { name: `Where person ${i} is` })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Remove person 2' }))
    expect(useCreateStore.getState().swapFigures).toHaveLength(3)
  })

  it('never switches the model by itself: Kling stays, the row says it, a click on the recommendation picks SCAIL 2 (19.11.2026)', () => {
    useCreateStore.getState().setCloudOpModel('kling-v3-pro-motion-control')
    open()
    fireEvent.click(screen.getByRole('button', { name: /Add person/ }))
    expect(useCreateStore.getState().cloudOpModel).toBe('kling-v3-pro-motion-control')
    expect(document.querySelector('[data-swap-row-limit="2"]')!.textContent).toBe('Kling 3.0 Pro replaces one person.')
    expect(document.querySelector('[data-swap-row-limit="1"]')).toBeNull()
    const rec = document.querySelector('[data-swap-recommend]') as HTMLButtonElement
    expect(rec.textContent).toBe('Use SCAIL-2, takes up to 3 people')
    fireEvent.click(rec)
    expect(useCreateStore.getState().cloudOpModel).toBe('scail-2')
    fireEvent.click(screen.getByRole('button', { name: /Add person/ }))
    fireEvent.click(screen.getByRole('button', { name: /Add person/ }))
    // Four people on SCAIL 2: still SCAIL 2, OpenJutsu only recommended.
    expect(useCreateStore.getState().cloudOpModel).toBe('scail-2')
    expect((document.querySelector('[data-swap-recommend]') as HTMLElement).dataset.swapRecommend).toBe(SWAP_OPENJUTSU_MODEL)
  })

  it('OpenJutsu (one step) arms Create with the video, every photo and the consent', () => {
    useCreateStore.getState().setCloudOpModel(SWAP_OPENJUTSU_MODEL)
    open()
    expect(create().disabled).toBe(true)
    act(() => { useCreateStore.setState({ videoInput: clip, swapFrame: FRAME } as never) })
    expect(create().disabled).toBe(true)
    act(() => { useCreateStore.setState({ swapFigures: [{ image: photo, role: '' }, { image: null, role: '' }] }) })
    expect(create().disabled).toBe(true)
    act(() => { useCreateStore.setState({ swapFigures: [{ image: photo, role: '' }, { image: photo, role: 'the man on the right' }] }) })
    expect(create().disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(useCreateStore.getState().swapConsent).toBe(true)
    expect(create().disabled).toBe(false)
    // No frame step on OpenJutsu.
    expect(document.querySelector('[data-swap-built]')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(create().disabled).toBe(true)
  })

  it('shows the consent box on SCAIL 2 and Kling too', () => {
    open()
    expect(document.querySelector('[data-swap-consent]')).toBeTruthy()
    cleanup()
    useCreateStore.getState().setCloudOpModel('kling-v3-pro-motion-control')
    open()
    expect(document.querySelector('[data-swap-consent]')).toBeTruthy()
  })

  it('OpenJutsu: names the live price in the bar beside the length (15 s, not 120 s)', async () => {
    useCreateStore.getState().setCloudOpModel(SWAP_OPENJUTSU_MODEL)
    videoLength.seconds = 20
    useCreateStore.setState({ videoInput: clip, swapFrame: FRAME } as never)
    open()
    await act(async () => {})
    expect(lengthButton().textContent).toBe('15 s')
    expect(total()).toBe('302,000 credits')
    expect(split()).toBe('video 302k')
    act(() => { useCreateStore.getState().setSwapSeconds(10) })
    expect(lengthButton().textContent).toBe('10 s')
    expect(total()).toBe('202,000 credits')
  })

  it('SCAIL 2: frame and video together in the bar', async () => {
    videoLength.seconds = 20
    useCreateStore.setState({ swapSeconds: 6, videoInput: clip, swapFrame: FRAME } as never)
    open()
    await act(async () => {})
    // 6 s at 720p (8,000/s) plus the first frame (Nano Banana Pro 2k, 14,000).
    expect(total()).toBe('62,000 credits')
    expect(document.querySelector('[data-clip-price] b')?.textContent).toBe('62k')
    expect(split()).toBe('frame 14k + video 48k')
  })

  it('Kling 6 s: 100,800 credits for the video', async () => {
    useCreateStore.getState().setCloudOpModel('kling-v3-pro-motion-control')
    videoLength.seconds = 20
    useCreateStore.setState({ swapSeconds: 6, videoInput: clip, swapFrame: FRAME } as never)
    open()
    await act(async () => {})
    expect(total()).toBe('114,800 credits')
    expect(split()).toBe('frame 14k + video 101k')
  })
})

describe('two steps in the panel (14.11.2026)', () => {
  let rect: { mockRestore: () => void }
  beforeEach(() => {
    // jsdom measures nothing: the first frame is 100 x 200 pixels here.
    rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
  })
  afterEach(() => { rect.mockRestore() })

  const frameBox = () => screen.getByRole('group', { name: /First frame of your video/ })

  it('tap people: numbered marks, the place becomes the role, a tap on the mark removes it', () => {
    useCreateStore.setState({ videoInput: clip, swapFrame: FRAME } as never)
    const { rerender } = open()
    expect(screen.getByText(/^Tap each person you want to replace\./)).toBeTruthy()
    fireEvent.click(frameBox(), { clientX: 80, clientY: 60 })
    fireEvent.click(frameBox(), { clientX: 20, clientY: 70 })
    rerender(<Panel />)
    const figs = useCreateStore.getState().swapFigures
    expect(figs).toHaveLength(2)
    expect(figs.map((f) => f.mark)).toEqual([{ x: 0.8, y: 0.3 }, { x: 0.2, y: 0.35 }])
    // The place of each row comes from its tap.
    expect(document.querySelector('[data-swap-figure="1"] [data-swap-place]')!.textContent).toBe('right')
    expect(document.querySelector('[data-swap-figure="2"] [data-swap-place]')!.textContent).toBe('left')
    // Somebody who walks in later is added by the line, not by a tap.
    expect(screen.getByRole('button', { name: /Add person/ })).toBeTruthy()
    // 44 px to hit.
    const mark = screen.getByRole('button', { name: 'Remove mark 1' })
    expect(mark.className).toMatch(/h-11 w-11/)
    fireEvent.click(mark)
    expect(useCreateStore.getState().swapFigures).toHaveLength(1)
    expect(useCreateStore.getState().swapFigures[0].mark).toEqual({ x: 0.2, y: 0.35 })
  })

  it('marks up to 4, the model stays what it is (no silent switch), the rows over its limit say so', () => {
    useCreateStore.setState({ videoInput: clip, swapFrame: FRAME, cloudOpModel: 'kling-v3-pro-motion-control' } as never)
    open()
    fireEvent.click(frameBox(), { clientX: 10, clientY: 10 })
    expect(useCreateStore.getState().cloudOpModel).toBe('kling-v3-pro-motion-control')
    fireEvent.click(frameBox(), { clientX: 50, clientY: 10 })
    expect(useCreateStore.getState().cloudOpModel).toBe('kling-v3-pro-motion-control')
    expect(document.querySelector('[data-swap-people-blocker]')!.textContent).toMatch(/^Kling 3\.0 Pro replaces one person\./)
    fireEvent.click(frameBox(), { clientX: 90, clientY: 10 })
    fireEvent.click(frameBox(), { clientX: 30, clientY: 90 })
    expect(useCreateStore.getState().swapFigures).toHaveLength(4)
    expect(useCreateStore.getState().cloudOpModel).toBe('kling-v3-pro-motion-control')
    expect(document.querySelectorAll('[data-swap-row-limit]')).toHaveLength(3)
    fireEvent.click(frameBox(), { clientX: 60, clientY: 90 })
    expect(useCreateStore.getState().swapFigures).toHaveLength(4)
  })

  it('the picker shows Kling greyed out with "one person only" for several people, SCAIL 2 recommended', () => {
    useCreateStore.setState({ videoInput: clip, swapFrame: FRAME, swapFigures: [{ image: null, role: '' }, { image: null, role: '' }] } as never)
    // The chip itself: the Character tab's Swap picks its engines in the
    // settings (SwapPicks); the chip's rules for Swap stay pinned here.
    render(<ModelChip />)
    const chip = [...document.querySelectorAll('button')].find((b) => /SCAIL 2/.test(b.textContent ?? '') && !b.closest('[role=listbox]'))!
    fireEvent.click(chip)
    const kling = screen.getByText('Kling 3.0 Pro \u2022 Motion Control').closest('button') as HTMLButtonElement
    expect(kling.disabled).toBe(true)
    expect(kling.textContent).toMatch(/one person only/)
    fireEvent.click(kling)
    expect(useCreateStore.getState().cloudOpModel).not.toBe('kling-v3-pro-motion-control')
    const scail = screen.getAllByText(/SCAIL 2/).map((el) => el.closest('button')).find((b) => b?.textContent?.includes('Recommended'))
    expect(scail).toBeTruthy()
  })

  it('Build first frame, Does this look right?, Try again, Continue: only then Create', async () => {
    videoLength.seconds = 6.006
    useCreateStore.setState({
      videoInput: clip, swapFrame: FRAME, swapSeconds: null,
      swapFigures: [{ image: photo, role: '', mark: { x: 0.3, y: 0.4 } }], swapConsent: false,
    } as never)
    open()
    await act(async () => {})
    expect(create().disabled).toBe(true)
    const build = () => screen.getByRole('button', { name: /Build first frame/ }) as HTMLButtonElement
    // The tick stands before the frame step and counts for it too.
    expect(build().disabled).toBe(true)
    const box = document.querySelector('[data-swap-consent]')!
    expect(box.compareDocumentPosition(build()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(box.querySelector('input')!)
    expect(build().disabled).toBe(false)
    expect(build().title).toBe('Build first frame · 14,000 credits')
    expect(build().textContent).toMatch(/Build first frame\s*14k/)
    expect(create().disabled).toBe(true)
    await act(async () => { fireEvent.click(build()) })
    await screen.findByText('Does this look right?')
    expect(cloud.submitCloudJob).toHaveBeenCalledTimes(1)
    const first = cloud.submitCloudJob.mock.calls[0][0] as { model: string; prompt: string; params: Record<string, unknown> }
    expect(first.model).toBe('nano-banana-pro-edit')
    expect(first.params).toMatchObject({ swap_step: 'frame', swap_consent: true, max_credits: 14000, studio_options: { aspect_ratio: '9:16', resolution: '2k', output_format: 'jpeg' } })
    expect(first.params.image_paths as string[]).toHaveLength(2)
    expect(first.prompt).toMatch(/^Replace the person in the first image/)
    expect(screen.getByRole('img', { name: 'Original' })).toBeTruthy()
    expect((screen.getByRole('img', { name: 'New first frame' }) as HTMLImageElement).src).toBe('https://ours.example/bild.jpg')
    expect(create().disabled).toBe(true)

    // Try again with a sentence on what is wrong: a new image job.
    fireEvent.change(screen.getByRole('textbox', { name: "What's wrong?" }), { target: { value: 'head turned to the side' } })
    const again = screen.getByRole('button', { name: /Try again · 14k credits/ })
    await act(async () => { fireEvent.click(again) })
    await waitFor(() => expect(cloud.submitCloudJob).toHaveBeenCalledTimes(2))
    expect((cloud.submitCloudJob.mock.calls[1][0] as { prompt: string }).prompt).toMatch(/Fix this from the last attempt: head turned to the side$/)
    await screen.findByText('Does this look right?')

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(screen.getByText(/First frame ready/)).toBeTruthy()
    expect(create().disabled).toBe(false)

    // Another place (the person comes in later now): the frame no longer
    // fits and expires.
    act(() => { useCreateStore.setState({ swapFigures: useCreateStore.getState().swapFigures.map((f) => ({ ...f, role: 'the man in red' })) }) })
    expect(create().disabled).toBe(true)
    await waitFor(() => expect(useCreateStore.getState().swapBuilt).toBeNull())
    expect(screen.getByRole('button', { name: /Build first frame/ })).toBeTruthy()
  })

  it('another video drops the first frame, the marks and the built frame', () => {
    useCreateStore.setState({
      videoInput: clip, swapFrame: FRAME, swapBuilt: { jobId: 'b', url: 'x', key: 'k', confirmed: true },
      swapFigures: [{ image: photo, role: '', mark: { x: 0.5, y: 0.5 } }],
    } as never)
    useCreateStore.getState().setVideoInput({ name: 'other.mp4', url: 'blob:w', blob: new Blob(['w']) })
    const s = useCreateStore.getState()
    expect(s.swapFrame).toBeNull()
    expect(s.swapBuilt).toBeNull()
    expect(s.swapFigures[0].mark).toBeNull()
    expect(s.swapFigures[0].image).toBe(photo)
  })
})

describe('the Swap Stage', () => {
  it('shows original + new person -> result, and one tile per person when there are several', () => {
    render(<SwapStage />)
    expect(screen.getByRole('button', { name: 'Add original video' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add photo of the new person' })).toBeTruthy()
    expect(screen.getByText('Result')).toBeTruthy()
    cleanup()
    useCreateStore.setState({ swapFigures: [{ image: photo, role: '' }, { image: null, role: '' }, { image: photo, role: '' }] })
    render(<SwapStage />)
    expect(document.querySelector('[data-swap-figure-grid]')?.children).toHaveLength(3)
    expect(screen.getByText('3 new people')).toBeTruthy()
  })
})

describe('Sound in the Swap and Motion panel (14.11.2026)', () => {
  const VOICE = { name: 'voice.mp3', url: 'blob:a', blob: new Blob(['a'], { type: 'audio/mpeg' }) }
  const sound = () => screen.getByRole('radiogroup', { name: 'Sound' })
  const option = (name: string) => screen.getByRole('radio', { name }) as HTMLButtonElement
  beforeEach(() => {
    // LatentSync as the server lists it: by the length of the voice, 3,000 per second, at least 3 s.
    useCloudCatalogStore.setState({
      models: neuerServer().map((m) => (m.id === 'latentsync'
        ? { ...m, credits: { base: 9000, length: { basis: 'audio' as const, block: 1, per_block: 3000, min: 3, max: 300, quote: 10 } } }
        : m)),
    })
    useCreateStore.setState({ sound: 'original', lipsyncModel: 'latentsync', lipsyncCredits: null, audioInput: null, voiceFromJob: null } as never)
  })

  it('three choices after the people, the original sound by default', () => {
    open()
    expect([...sound().querySelectorAll('[role=radio]')].map((r) => r.textContent)).toEqual(['Original sound', 'No sound', 'New voice, lips in sync'])
    expect(option('Original sound').getAttribute('aria-checked')).toBe('true')
    const people = panel().querySelector('[data-swap-figures]')!
    expect(people.compareDocumentPosition(panel().querySelector('[data-sound-controls]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(option('No sound'))
    expect(useCreateStore.getState().sound).toBe('none')
  })

  it('with two people lip sync is greyed out, with the note', () => {
    useCreateStore.setState({ swapFigures: [{ image: null, role: '' }, { image: null, role: '' }] })
    open()
    expect(option('New voice, lips in sync').disabled).toBe(true)
    expect(option('New voice, lips in sync').title).toBe('Lip sync works with one person')
    // The sketch's short word beside the choice; the full sentence is its title.
    expect(document.querySelector('[data-sound-note=lipsync-blocked]')?.textContent).toBe('one person only')
    fireEvent.click(option('New voice, lips in sync'))
    expect(useCreateStore.getState().sound).toBe('original')
  })

  it('a server without the lip sync models: greyed out, not broken', () => {
    useCloudCatalogStore.setState({ models: neuerServer().filter((m) => m.id !== 'latentsync') })
    open()
    expect(option('New voice, lips in sync').disabled).toBe(true)
    expect(document.querySelector('[data-sound-note=lipsync-blocked]')?.textContent).toBe('Lip sync is not available on this LU Cloud')
  })

  it('lip sync: the voice chip, swap and lip sync together on the slider and on Create; a longer voice is cut', async () => {
    videoLength.seconds = 9
    const figures = [{ image: photo, role: '', mark: { x: 0.4, y: 0.4 } }]
    useCreateStore.setState({ videoInput: clip, swapFrame: FRAME, swapFigures: figures, swapSeconds: 6, swapConsent: true } as never)
    const { rerender } = open()
    fireEvent.click(option('New voice, lips in sync'))
    expect(document.querySelector('[data-sound-lipsync]')).toBeTruthy()
    expect(screen.getByText(/a second step puts the new voice in/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add voice/ })).toBeTruthy()
    useCreateStore.setState({ audioInput: VOICE })
    await act(async () => {})
    rerender(<Panel />)
    await act(async () => {})
    // 9 s voice, 6 s clip: LatentSync bills 6 s = 18,000.
    expect(useCreateStore.getState().lipsyncCredits).toBe(18000)
    expect(document.querySelector('[data-sound-note=cut]')?.textContent).toBe('Your voice is 9 s, the clip 6 s. The voice is cut to the clip.')
    expect(document.querySelector('[data-sound-price]')?.textContent).toBe('+ lip sync 18k (6 s)')
    // 6 s SCAIL 2 720p (48,000) + first frame (14,000) + lip sync (18,000).
    expect(total()).toBe('80,000 credits')
    expect(split()).toBe('frame 14k + video 48k + lip sync 18k')
    // Create: video + lip sync, once the first frame is confirmed.
    const { swapKeyOf } = await import('../../../../lib/create/swap-frame')
    useCreateStore.setState({ swapBuilt: { jobId: 'b', url: 'x', key: swapKeyOf('blob:dance', figures), confirmed: true } })
    await act(async () => {})
    await waitFor(() => expect(create().disabled).toBe(false))
    expect(create().textContent).toMatch(/Create · 66k/)
    // Without a voice no start.
    useCreateStore.setState({ audioInput: null })
    await act(async () => {})
    expect(create().disabled).toBe(true)
  })

  it('Motion: the sound choice on the cloud only; the local lanes do not show it', () => {
    useCreateStore.getState().setIntent('motion')
    const { rerender } = open()
    expect(document.querySelector('[data-sound-controls=motion]')).toBeTruthy()
    useCreateStore.setState({ backend: 'local' })
    rerender(<Panel />)
    expect(document.querySelector('[data-sound-controls]')).toBeNull()
  })
})
