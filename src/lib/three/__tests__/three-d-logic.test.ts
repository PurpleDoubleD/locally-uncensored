import { describe, it, expect, beforeEach } from 'vitest'
import { checkPromptSafety } from '../../render/safety'
import { threeDProvenance, threeDPicturePrompt, threeDGalleryItem } from '../run-local-3d'
import { mac3dResolution } from '../../mac-3d'
import { studioIntentOf, intentRoles } from '../../render/create-studio'
import { intentToJob, quotaCostKind } from '../../render/cloud-jobs'
import { evenPick } from '../../../components/create/experimental/ThreeDControls'
import { useCreateStore, opSlot } from '../../../stores/createStore'
import { galleryLabel } from '../../render/gallery-label'
import { writePoster, readPoster, deletePoster, onPoster, __resetPostersForTests } from '../mesh-poster'

const ref = (name: string, url = `data:image/png;base64,${name}`) => ({ filename: '', url, width: 1, height: 1, name })

describe('3D content gate reads where the pictures came from', () => {
  it('names every picture: the front and every side', () => {
    const text = threeDProvenance({ source: ref('teapot.png'), threeDViews: [ref('left.png'), ref('back.png')], gallery: [] })
    expect(text).toContain('teapot.png')
    expect(text).toContain('left.png')
    expect(text).toContain('back.png')
  })
  it('a gallery picture brings its prompt, and a blocked prompt there blocks the run', () => {
    const url = 'data:image/png;base64,abc'
    const gallery = [{ prompt: 'nude schoolgirl', promptOriginal: '', label: '', dataUrl: url }]
    const text = threeDProvenance({ source: ref('x.png', url), threeDViews: [], gallery })
    expect(checkPromptSafety(`  ${text}`).blocked).toBe(true)
  })
  it('a harmless picture passes', () => {
    const text = threeDProvenance({ source: ref('clay-teapot.jpg'), threeDViews: [], gallery: [] })
    expect(checkPromptSafety(text).blocked).toBe(false)
  })
  it('a file name alone can block', () => {
    const text = threeDProvenance({ source: ref('loli-nude.png'), threeDViews: [], gallery: [] })
    expect(checkPromptSafety(text).blocked).toBe(true)
  })
})

describe('3D studio intents', () => {
  it('each way runs its own roles', () => {
    expect(studioIntentOf('3d', 'text')).toBe('3d-text')
    expect(studioIntentOf('3d', 'image')).toBe('3d-image')
    expect(studioIntentOf('3d', 'video')).toBe('3d-video')
    expect(studioIntentOf('music', 'video')).toBe('music')
    expect(intentRoles('3d-text')).toEqual(['mesh-text'])
    expect(intentRoles('3d-video')[0]).toBe('mesh-views')
  })
  it('cloud 3D is a studio run of kind 3d', () => {
    expect(intentToJob('3d')).toEqual({ kind: '3d', op: 'studio' })
    expect(quotaCostKind('3d')).toBe('image')
    expect(quotaCostKind('video')).toBe('video')
  })
})

describe('3D helpers', () => {
  it('spreads the picked moments over the video', () => {
    expect(evenPick(8, 4)).toEqual([0, 2, 4, 5])
    expect(evenPick(8, 1)).toEqual([3])
    expect(evenPick(2, 4)).toEqual([0, 1])
    expect(evenPick(0, 4)).toEqual([])
  })
  it('steers the picture of "From text" to one whole object', () => {
    expect(threeDPicturePrompt('a clay teapot.')).toMatch(/^a clay teapot, a single object/)
  })
  it('names a gallery entry by its way when it has no prompt', () => {
    const item = threeDGalleryItem({ id: 'a', way: 'image', model: 'TripoSR', prompt: '', seed: 1, localPath: '/x.glb' })
    expect(item.type).toBe('3d')
    expect(galleryLabel(item)).toBe('3D from image')
    const named = threeDGalleryItem({ id: 'b', way: 'text', model: 'TripoSR', prompt: 'a robot', seed: 1 })
    expect(galleryLabel(named)).toBe('a robot')
  })
  it('the detail steps map onto growing grids', () => {
    expect(mac3dResolution('draft')).toBeLessThan(mac3dResolution('standard'))
    expect(mac3dResolution('standard')).toBeLessThan(mac3dResolution('fine'))
  })
})

describe('3D in the store', () => {
  beforeEach(() => {
    useCreateStore.setState({ threeDWay: 'image', threeDViews: [], cloudStudioOptions: {} })
  })
  it('a new way drops the sides and the studio options of the old one', () => {
    const s = useCreateStore.getState()
    s.setThreeDViews([ref('l'), ref('b'), ref('r'), ref('x'), ref('y')])
    expect(useCreateStore.getState().threeDViews).toHaveLength(4)
    useCreateStore.setState({ cloudStudioOptions: { resolution: '1536' } })
    s.setIntent('3d')
    s.setThreeDWay('video')
    expect(useCreateStore.getState().threeDViews).toEqual([])
  })
  it('each way is its own pick slot', () => {
    const s = useCreateStore.getState()
    s.setIntent('3d')
    expect(opSlot({ ...useCreateStore.getState(), threeDWay: 'text' })).toBe('3d:text')
    expect(opSlot({ ...useCreateStore.getState(), threeDWay: 'image' })).toBe('3d:image')
  })
  it('the 3D tab keeps the picture on the Stage', () => {
    const s = useCreateStore.getState()
    s.setIntent('image')
    s.setSource(ref('teapot'))
    s.setIntent('3d')
    expect(useCreateStore.getState().source?.name).toBe('teapot')
    expect(useCreateStore.getState().intent()).toBe('3d')
  })
})

describe('3D posters', () => {
  beforeEach(() => __resetPostersForTests())
  it('keeps a still per entry and tells the tiles', async () => {
    const heard: string[] = []
    onPoster((id) => heard.push(id))
    await writePoster('a', 'data:image/jpeg;base64,AAAA')
    expect(await readPoster('a')).toBe('data:image/jpeg;base64,AAAA')
    expect(heard).toEqual(['a'])
    await deletePoster('a')
    expect(await readPoster('a')).toBeNull()
  })
  it('takes only pictures', async () => {
    await writePoster('b', 'javascript:alert(1)')
    expect(await readPoster('b')).toBeNull()
  })
})
