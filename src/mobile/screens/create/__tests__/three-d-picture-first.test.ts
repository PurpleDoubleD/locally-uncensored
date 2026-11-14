/**
 * "Picture first" on the phone (3.1.0, cloud only): the 3D tool's Text way
 * offers it first, prices it as picture plus model, and names it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import schemas from '../../../../lib/render/provider-schemas.json'
import { STUDIO_MODELS, type Schema } from '../../../../lib/render/studio-contract'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { useCreateStore } from '../../../../stores/createStore'
import { installContentPolicyCap } from '../../../../lib/content-policy-cap'
import { pictureFirstPictureModel } from '../../../../lib/three/picture-first'
import { CREATE_STRINGS as T } from '../../../strings/create'
import { runModel, toolModels } from '../parts/catalog'
import { threeDModelFacts } from '../parts/three-d'
import { MESH_IMAGE, MESH_TEXT, installThreeDStudio, threeDCatalogEntries } from './fixtures/three-d-models'

const picks = { cloudImageModel: '', cloudVideoModel: '', cloudOpModel: '' }
const fallbackCredits = { image: null, video: null, audio: null }
const rows = (way: 'text' | 'image') => toolModels('3d', { character: null, characterUse: false, musicSeconds: 0, fallbackCredits, threeDWay: way })

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
  useCloudCatalogStore.setState({
    models: [
      ...catalogBefore, ...threeDCatalogEntries(),
      { id: 'z-image', label: 'Z-Image Base', kind: 'image', adult: true, quote_required: true, tier: 'best', weights: 'open' },
      { id: 'qwen-image-2.1', label: 'Qwen Image 2.1', kind: 'image', quote_required: true, tier: 'best', weights: 'open' },
    ] as typeof catalogBefore,
  })
  useCreateStore.getState().setIntent('3d')
  useCreateStore.setState({ threeDWay: 'text', threeDViews: [], source: null, cloudStudioOptions: {}, cloudOpModel: '' })
})

describe('Picture first on the phone', () => {
  it('leads the Text way and is the model that runs by default', () => {
    const list = rows('text')
    expect(list.map((r) => r.id).sort()).toEqual([MESH_IMAGE, MESH_TEXT].sort())
    expect(list.find((r) => r.id === MESH_IMAGE)?.label).toBe('Picture first')
    expect(runModel('3d', picks, null, false, 'text')).toMatchObject({ id: MESH_IMAGE, studio: true })
    expect(runModel('3d', { ...picks, cloudOpModel: MESH_TEXT }, null, false, 'text').id).toBe(MESH_TEXT)
  })

  it('its row costs the picture and the model together, the picture way only the model', () => {
    const text = rows('text').find((r) => r.id === MESH_IMAGE)
    const image = rows('image').find((r) => r.id === MESH_IMAGE)
    // TRELLIS.2 at its default 1024 is 20,000 credits, the picture 1,000.
    expect(image?.credits).toBe(20000)
    expect(text?.credits).toBe(21000)
    expect(image?.label).toBe('TRELLIS.2')
  })

  it('says what it does, on the Text way only', () => {
    expect(threeDModelFacts(MESH_IMAGE, 'text').pictureFirst).toBe(true)
    expect(threeDModelFacts(MESH_IMAGE, 'image').pictureFirst).toBe(false)
    expect(threeDModelFacts(MESH_TEXT, 'text').pictureFirst).toBe(false)
    expect(T.threeD.pictureFirst).toBe('LU paints a picture first, then builds the model from it.')
  })

  it('a store build that caps the content policy paints with a model that keeps its filter', () => {
    const off = installContentPolicyCap(() => 'soft')
    try {
      expect(pictureFirstPictureModel()).toBe('qwen-image-2.1')
    } finally {
      off()
    }
  })
})
