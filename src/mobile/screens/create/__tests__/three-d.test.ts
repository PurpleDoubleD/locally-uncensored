/**
 * 3D on the phone (3.1.0, cloud only): the tool, its ways, the models of
 * each way, the detail step, the still frames of a video, the refusal of
 * "My computer", and the file a 3D result is saved and shared as.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const frames = vi.hoisted(() => ({ count: 8, fail: false }))
vi.mock('../../../../lib/video-frames', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/video-frames')>('../../../../lib/video-frames')
  return {
    ...actual,
    framesAcrossVideo: vi.fn(async () => {
      if (frames.fail) throw new Error('Could not load the video')
      return Array.from({ length: frames.count }, (_, i) => new Blob([`frame-${i}`], { type: 'image/jpeg' }))
    }),
  }
})
vi.mock('../parts/photos', async () => {
  const actual = await vi.importActual<typeof import('../parts/photos')>('../parts/photos')
  return {
    ...actual,
    loadPhoneImageFromBlob: vi.fn(async (_b: Blob, name: string) => ({ filename: name, name, url: `data:image/jpeg;base64,${name}`, width: 64, height: 64 })),
  }
})

import schemas from '../../../../lib/render/provider-schemas.json'
import { STUDIO_MODELS, type Schema } from '../../../../lib/render/studio-contract'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { useCreateStore } from '../../../../stores/createStore'
import { checkPromptSafety, SAFETY_BLOCK_MESSAGE } from '../../../../lib/render/safety'
import { createRemoteCreateRunner, THREE_D_NOT_ON_COMPUTER, type RemoteCreateDeps, type RemoteCreateJob } from '../../../../lib/remote-create-runner'
import { evenPick as desktopEvenPick } from '../../../../components/create/experimental/ThreeDControls'
import { CREATE_STRINGS as T } from '../../../strings/create'
import { runModel, toolModels, toolProbe } from '../parts/catalog'
import { saveName, saveTarget } from '../parts/files'
import { blockReason, type ReadyInput } from '../parts/run-state'
import { applyPicks, clearVideo, evenPick, pickDetail, pickWay, readVideoFrames, shownDetail, tapFrame, threeDModelFacts, togglePick, useThreeDVideo } from '../parts/three-d'
import { COMPUTER_TOOLS } from '../parts/computer-tools'
import { TOOL_IDS, toolFacts, toolTakesPhoto } from '../parts/tools'
import { MESH_IMAGE, MESH_TEXT, MESH_VIEWS, installThreeDStudio, threeDCatalogEntries } from './fixtures/three-d-models'

const picks = { cloudImageModel: '', cloudVideoModel: '', cloudOpModel: '' }
const fallbackCredits = { image: null, video: null, audio: null }

let undo: () => void = () => {}
let catalogBefore: ReturnType<typeof useCloudCatalogStore.getState>['models']

beforeAll(() => {
  undo = installThreeDStudio(STUDIO_MODELS, schemas as Record<string, Schema>)
  catalogBefore = useCloudCatalogStore.getState().models
})
afterAll(() => {
  undo()
  useCloudCatalogStore.setState({ models: catalogBefore })
})
beforeEach(() => {
  useCloudCatalogStore.setState({ models: [...catalogBefore, ...threeDCatalogEntries()] as typeof catalogBefore })
  useCreateStore.getState().setIntent('3d')
  useCreateStore.setState({ threeDWay: 'image', threeDViews: [], source: null, cloudStudioOptions: {}, cloudOpModel: '' })
  useThreeDVideo.setState({ name: null, frames: [], picked: [], reading: false })
  frames.count = 8
  frames.fail = false
})
afterEach(() => vi.clearAllMocks())

describe('the 3D tool', () => {
  it('stands last in the row, so no other tool moves', () => {
    expect(TOOL_IDS[TOOL_IDS.length - 1]).toBe('3d')
    expect(TOOL_IDS.indexOf('motion')).toBe(TOOL_IDS.length - 2)
  })

  it('from words wants a prompt, from a photo or a video a picture and no prompt', () => {
    expect(toolFacts('3d', 'text')).toMatchObject({ kind: '3d', needsSource: false, prompt: 'yes', batch: false, hasModels: true })
    expect(toolFacts('3d', 'image')).toMatchObject({ needsSource: true, prompt: 'no' })
    expect(toolFacts('3d', 'video')).toMatchObject({ needsSource: true, prompt: 'no' })
    // Other tools do not read the way.
    expect(toolFacts('edit', 'text')).toEqual(toolFacts('edit'))
  })

  it('keeps a photo the user adds, on every way', () => {
    expect(toolTakesPhoto('3d')).toBe(true)
    expect(toolTakesPhoto('image')).toBe(false)
  })

  it('is not a tool of "My computer" in v1', () => {
    expect(COMPUTER_TOOLS as readonly string[]).not.toContain('3d')
  })

  it('has a text for every place the phone shows it', () => {
    expect(T.tool['3d'].name).toBe('3D model')
    expect(T.threeD.ways).toEqual({ text: 'Text', image: 'Image', video: 'Video' })
    expect(T.block['no-3d-video']).toBeTruthy()
    expect(T.gal.kind['3d']).toBe('3D model')
  })
})

describe('the catalog decides', () => {
  it('the tab is there as soon as the catalog lists a 3D model, and gone without one', () => {
    expect(toolProbe()['3d']).toBe(true)
    useCloudCatalogStore.setState({ models: catalogBefore })
    expect(toolProbe()['3d']).toBe(false)
  })

  it('each way lists only the models of its way', () => {
    const ids = (way: 'text' | 'image' | 'video') => toolModels('3d', { character: null, characterUse: false, musicSeconds: 0, fallbackCredits, threeDWay: way }).map((r) => r.id)
    expect(ids('text')).toEqual([MESH_TEXT])
    // The picker groups by tier like every other list; which one runs first is the run's matter (next test).
    expect(ids('image').sort()).toEqual([MESH_IMAGE, MESH_VIEWS].sort())
    expect(ids('video').sort()).toEqual([MESH_IMAGE, MESH_VIEWS].sort())
  })

  it('the run takes the model of the way, also with a pick left from another way', () => {
    expect(runModel('3d', picks, null, false, 'text').id).toBe(MESH_TEXT)
    expect(runModel('3d', picks, null, false, 'video').id).toBe(MESH_VIEWS)
    expect(runModel('3d', { ...picks, cloudOpModel: MESH_TEXT }, null, false, 'image').id).toBe(MESH_IMAGE)
    expect(runModel('3d', { ...picks, cloudOpModel: MESH_VIEWS }, null, false, 'image')).toMatchObject({ id: MESH_VIEWS, studio: true })
  })

  it('a model says how many pictures it takes and whether it has a detail step', () => {
    expect(threeDModelFacts(MESH_VIEWS)).toEqual({ maxViews: 4, hasDetail: true })
    expect(threeDModelFacts(MESH_IMAGE)).toEqual({ maxViews: 1, hasDetail: true })
    expect(threeDModelFacts(MESH_TEXT)).toEqual({ maxViews: 1, hasDetail: false })
    expect(threeDModelFacts(undefined)).toEqual({ maxViews: 1, hasDetail: false })
  })
})

describe('the detail step', () => {
  it('writes the model’s own field, where the price and the booking read it', () => {
    expect(shownDetail(MESH_IMAGE, {}, 'standard')).toBe('standard')
    pickDetail(MESH_IMAGE, 'fine')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({ resolution: 1536 })
    expect(shownDetail(MESH_IMAGE, useCreateStore.getState().cloudStudioOptions, 'standard')).toBe('fine')
    pickDetail(MESH_VIEWS, 'draft')
    expect(useCreateStore.getState().cloudStudioOptions).toMatchObject({ texture_quality: 'standard' })
  })
})

describe('the still frames of a video', () => {
  it('spread like on the desktop', () => {
    for (const [n, want] of [[8, 4], [8, 1], [2, 4], [0, 4], [5, 3], [8, 2]]) expect(evenPick(n, want)).toEqual(desktopEvenPick(n, want))
  })

  it('a tap swaps a moment, never the last one, and keeps the order of the video', () => {
    expect(togglePick([0, 2, 4, 5], 7, 4)).toEqual([2, 4, 5, 7])
    expect(togglePick([0, 2], 5, 4)).toEqual([0, 2, 5])
    expect(togglePick([0, 2], 2, 4)).toEqual([0])
    expect(togglePick([3], 3, 4)).toEqual([3])
    expect(togglePick([3], 6, 1)).toEqual([6])
  })

  it('the picked moments become the source and the further sides; the video is never kept', async () => {
    const out = await readVideoFrames(new File(['x'], 'teapot.mp4', { type: 'video/mp4' }), 4)
    expect(out).toEqual({ ok: true })
    const st = useCreateStore.getState()
    expect(st.threeDWay).toBe('video')
    expect(st.source?.name).toBe('teapot-frame-1.jpg')
    expect(st.threeDViews.map((v) => v.name)).toEqual(['teapot-frame-3.jpg', 'teapot-frame-5.jpg', 'teapot-frame-6.jpg'])
    expect(useCreateStore.getState().videoInput).toBeNull()
    tapFrame(7, 4)
    expect(useCreateStore.getState().source?.name).toBe('teapot-frame-3.jpg')
    expect(useCreateStore.getState().threeDViews).toHaveLength(3)
  })

  it('a model that takes one picture gets the middle moment only', async () => {
    await readVideoFrames(new File(['x'], 'cup.mov', { type: 'video/quicktime' }), 1)
    expect(useCreateStore.getState().source?.name).toBe('cup-frame-4.jpg')
    expect(useCreateStore.getState().threeDViews).toEqual([])
  })

  it('back on the video way after a photo, the moments come back', async () => {
    await readVideoFrames(new File(['x'], 'cup.webm', { type: 'video/webm' }), 4)
    pickWay('image', 4)
    expect(useCreateStore.getState().threeDViews).toEqual([])
    pickWay('video', 4)
    expect(useCreateStore.getState().threeDViews).toHaveLength(3)
    clearVideo()
    expect(useCreateStore.getState().source).toBeNull()
    applyPicks(4)
    expect(useCreateStore.getState().source).toBeNull()
  })

  it('a file that is no video, or a video that does not play, says so and keeps nothing', async () => {
    expect(await readVideoFrames(new File(['x'], 'a.png', { type: 'image/png' }), 4)).toEqual({ ok: false, reason: 'wrong-kind' })
    frames.fail = true
    expect(await readVideoFrames(new File(['x'], 'a.mp4', { type: 'video/mp4' }), 4)).toEqual({ ok: false, reason: 'unreadable' })
    expect(useThreeDVideo.getState().frames).toEqual([])
  })

  it('without a frame the run waits for a video, not for a photo', () => {
    const base: ReadyInput = {
      online: true, tool: '3d', promptNeeded: false, prompt: '', sourceNeeded: true, hasSource: false, maskNeeded: false, hasMask: false,
      characterUse: false, hasCharacter: false, trainPhotos: 0, minTrainPhotos: 0, hasVoice: false, needsPortrait: false, needsClip: false,
      hasVideo: false, hasExtendClip: false, hasModel: true, priceState: 'known', quotaKnown: true,
    }
    expect(blockReason({ ...base, threeDWay: 'video' })).toBe('no-3d-video')
    expect(blockReason({ ...base, threeDWay: 'image' })).toBe('no-source')
    expect(blockReason({ ...base, threeDWay: 'text', sourceNeeded: false, promptNeeded: true })).toBe('no-prompt')
  })
})

describe('a 3D result leaves the phone as a GLB', () => {
  it('is saved to Files with the ending .glb, whatever type the bytes carry', () => {
    expect(saveTarget('3d')).toBe('files')
    const { name, mime } = saveName('3d', 'application/octet-stream', Date.UTC(2026, 10, 13), 'res-abcdef')
    expect(name).toMatch(/\.glb$/)
    expect(mime).toBe('model/gltf-binary')
  })
})

describe('"My computer" refuses 3D in v1, after the content gate', () => {
  function rig(): { deps: RemoteCreateDeps; finished: { ok: boolean; error: string | null }[]; generated: number } {
    const r = { finished: [] as { ok: boolean; error: string | null }[], generated: 0, deps: null as unknown as RemoteCreateDeps }
    r.deps = {
      tool: 'comfyui',
      runLane: async () => { r.generated++; return '' },
      galleryItems: () => [],
      replyGallery: async () => null,
      generate: async () => { r.generated++; return '' },
      cancel: () => {},
      listModels: async () => ({ kinds: {}, engine_ready: true }),
      desktopBusy: () => false,
      inputRef: () => undefined,
      progress: async () => true,
      finish: async (_id, ok, error) => { r.finished.push({ ok, error }) },
      replyCapabilities: async () => null,
      addToGallery: () => {},
    }
    return r
  }
  const job = (prompt: string): RemoteCreateJob => ({ id: 'j', kind: '3d' as RemoteCreateJob['kind'], prompt, negative: '', model: null, width: 0, height: 0, steps: null, seed: null, count: 1, conversation_id: 'remote-create:j' })

  it('a harmless prompt gets the plain sentence and nothing runs', async () => {
    const r = rig()
    await createRemoteCreateRunner(r.deps).handle({ action: 'run', job: job('a clay teapot') })
    expect(r.finished).toEqual([{ ok: false, error: THREE_D_NOT_ON_COMPUTER }])
    expect(r.generated).toBe(0)
  })

  it('a refused prompt reads as refused, not as "not here"', async () => {
    const prompt = 'nude schoolgirl'
    expect(checkPromptSafety(prompt).blocked).toBe(true)
    const r = rig()
    await createRemoteCreateRunner(r.deps).handle({ action: 'run', job: job(prompt) })
    expect(r.finished[0].ok).toBe(false)
    expect(r.finished[0].error).not.toBe(THREE_D_NOT_ON_COMPUTER)
    expect(r.finished[0].error).toBe(SAFETY_BLOCK_MESSAGE)
    expect(r.generated).toBe(0)
  })
})
