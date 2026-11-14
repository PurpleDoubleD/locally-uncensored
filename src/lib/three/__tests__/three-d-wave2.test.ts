// The second cloud wave of 3D (14.11.2026): thirteen studio models, taken
// over field for field from the web snapshot. Prices follow the formula on the
// provider's model pages until the measurement at /model/price.
import { beforeEach, describe, expect, it } from 'vitest'
import { STUDIO_MODELS, studioBaseCredits, studioCredits, studioFields, studioOptions, studioSchema } from '../../render/studio-contract'
import { presetModels, type StepRole } from '../../render/preset-models'
import { cloudDetailOf, threeDControlFacts, threeDDetailField, threeDMaxViews } from '../three-d-models'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { neuerServer } from '../../render/__tests__/fixtures/test-catalogs'

// A server that lists every studio model, the second wave included.
beforeEach(() => {
  useCloudCatalogStore.setState({ models: neuerServer() })
})

const WAVE2 = [
  'hunyuan-3d-v3-text', 'hunyuan-3d-v3-image',
  'meshy-7.1-text', 'meshy-7.1-image', 'meshy-7.1-multi',
  'tripo-p1-text', 'tripo-p1-image', 'tripo-p1-multiview',
  'tripo-p2-text', 'tripo-p2-image', 'tripo-p2-multiview',
  'hi3d-3.0-image', 'hi3d-3.0-multiview',
]

const roleOf = (id: string): StepRole[] =>
  (['mesh-text', 'mesh-image', 'mesh-views'] as StepRole[]).filter((r) => presetModels(r).some((m) => m.id === id))

describe('3D, second cloud wave', () => {
  it('every model is a 3D studio model, filtered until a measurement says otherwise', () => {
    for (const id of WAVE2) {
      expect(STUDIO_MODELS[id], id).toMatchObject({ kind: '3d', adult: false })
      expect(STUDIO_MODELS[id].typical_s, id).toBeGreaterThan(0)
      expect(() => studioOptions(id, 'a clay teapot', {}), id).not.toThrow()
    }
  })

  it('each stands in the way its inputs name', () => {
    for (const id of ['hunyuan-3d-v3-text', 'meshy-7.1-text', 'tripo-p1-text', 'tripo-p2-text']) expect(roleOf(id), id).toEqual(['mesh-text'])
    for (const id of ['meshy-7.1-image', 'tripo-p1-image', 'tripo-p2-image', 'hi3d-3.0-image']) expect(roleOf(id), id).toEqual(['mesh-image'])
    for (const id of ['hunyuan-3d-v3-image', 'meshy-7.1-multi', 'tripo-p1-multiview', 'tripo-p2-multiview', 'hi3d-3.0-multiview']) {
      expect(roleOf(id), id).toEqual(['mesh-views'])
      expect(threeDMaxViews(id), id).toBe(4)
    }
    expect(threeDMaxViews('hi3d-3.0-image')).toBe(1)
  })

  it('the Detail step moves the texture quality of Tripo P1 and P2 and nothing on the others', () => {
    for (const id of ['tripo-p1-text', 'tripo-p2-image', 'tripo-p2-multiview']) {
      expect(threeDDetailField(id)?.field, id).toBe('texture_quality')
      expect(cloudDetailOf(threeDDetailField(id)!, undefined, id), id).toBe('draft')
    }
    for (const id of ['hunyuan-3d-v3-text', 'hunyuan-3d-v3-image', 'meshy-7.1-image', 'hi3d-3.0-image', 'hi3d-3.0-multiview']) {
      expect(threeDDetailField(id), id).toBeNull()
      expect(threeDControlFacts('cloud', id).hasDetail, id).toBe(false)
    }
  })

  it('no field that changes the price or the file format can be chosen', () => {
    for (const id of ['hi3d-3.0-image', 'hi3d-3.0-multiview']) {
      expect(studioFields(id), id).not.toHaveProperty('resolution')
      expect(studioFields(id), id).not.toHaveProperty('export_format')
      expect(studioSchema(id).properties?.export_format?.default, id).toBe('glb')
    }
    for (const id of ['tripo-p2-text', 'tripo-p2-image', 'tripo-p2-multiview']) expect(studioFields(id), id).not.toHaveProperty('quad')
    for (const id of ['meshy-7.1-text', 'meshy-7.1-image', 'meshy-7.1-multi']) {
      for (const k of ['enable_rigging', 'enable_animation', 'texture_resolution', 'geometry_resolution']) expect(studioFields(id), `${id}.${k}`).not.toHaveProperty(k)
    }
    // The named sides are pictures, never an option.
    for (const k of ['image', 'left_image', 'back_image', 'right_image']) expect(studioFields('hunyuan-3d-v3-image'), k).not.toHaveProperty(k)
  })

  it('prices: the base of each model, and Hunyuan3D 3 charges one surcharge for further sides', () => {
    expect(Object.fromEntries(WAVE2.map((id) => [id, studioBaseCredits(id)]))).toEqual({
      'hunyuan-3d-v3-text': 63_000, 'hunyuan-3d-v3-image': 63_000,
      'meshy-7.1-text': 120_000, 'meshy-7.1-image': 120_000, 'meshy-7.1-multi': 120_000,
      'tripo-p1-text': 48_000, 'tripo-p1-image': 60_000, 'tripo-p1-multiview': 60_000,
      'tripo-p2-text': 132_000, 'tripo-p2-image': 132_000, 'tripo-p2-multiview': 132_000,
      'hi3d-3.0-image': 252_000, 'hi3d-3.0-multiview': 252_000,
    })
    const o = studioOptions('hunyuan-3d-v3-image', '', {}, false)
    expect([1, 2, 4].map((n) => studioCredits('hunyuan-3d-v3-image', o, undefined, n))).toEqual([63_000, 81_000, 81_000])
    expect(studioCredits('meshy-7.1-image', studioOptions('meshy-7.1-image', '', { should_texture: false }, false))).toBe(80_000)
  })
})
