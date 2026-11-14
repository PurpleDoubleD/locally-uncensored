// Four 3D models of the second cloud wave are in the catalogue but not
// measured yet (14.11.2026, 3.1.0). The app hides them everywhere, also when
// an older server still lists them, and shows them only where the server
// marks the entry `unmeasured: true` (its switch for the paid measurement).
import { beforeEach, describe, expect, it } from 'vitest'
import { STUDIO_MODELS, unmeasuredHidden } from '../../render/studio-contract'
import { ALL_ROLES, presetModels } from '../../render/preset-models'
import { intentPickerModels } from '../../render/create-studio'
import { desktopCatalog } from '../../../api/cloud/catalog'
import { studioEntries, useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { toolProbe } from '../../../mobile/screens/create/parts/catalog'
import { neuerServer } from '../../render/__tests__/fixtures/test-catalogs'
import type { CloudModel } from '../../render/cloud-models'

const UNMEASURED = ['hi3d-3.0-image', 'hi3d-3.0-multiview', 'meshy-7.1-multi', 'tripo-p2-multiview']
const WAYS = ['3d-text', '3d-image', '3d-video'] as const

/** A server that lists every studio model without the mark, as one before
 *  3.1.0's switch would. */
const oldServer = (): CloudModel[] => neuerServer()
/** The same server with its switch for the measurement on. */
const measuringServer = (): CloudModel[] =>
  neuerServer().map((m) => (STUDIO_MODELS[m.id]?.unmeasured ? { ...m, unmeasured: true } : m))

const shown = (): string[] => [
  ...ALL_ROLES.flatMap((r) => presetModels(r).map((m) => m.id)),
  ...WAYS.flatMap((w) => intentPickerModels(w).map((m) => m.id)),
  ...studioEntries(Object.keys(STUDIO_MODELS)).map((m) => m.id),
]

beforeEach(() => {
  useCloudCatalogStore.setState({ models: oldServer() })
})

describe('3D models not measured yet', () => {
  it('exactly these four carry the mark in the snapshot', () => {
    expect(Object.keys(STUDIO_MODELS).filter((id) => STUDIO_MODELS[id].unmeasured).sort()).toEqual(UNMEASURED)
  })

  it('no role, picker or studio list shows them, even where the server lists them', () => {
    const ids = shown()
    for (const id of UNMEASURED) expect(ids, id).not.toContain(id)
    // Their measured siblings stay.
    for (const id of ['meshy-7.1-image', 'tripo-p2-image', 'tripo-p1-multiview']) expect(ids, id).toContain(id)
    // The phone still has 3D.
    expect(toolProbe()['3d']).toBe(true)
  })

  it('the catalogue the app keeps leaves them out unless the server marks them', () => {
    const kept = desktopCatalog({ models: oldServer() } as Parameters<typeof desktopCatalog>[0]).models.map((m) => m.id)
    for (const id of UNMEASURED) expect(kept, id).not.toContain(id)
    expect(kept).toContain('tripo-p2-image')
    const open = desktopCatalog({ models: measuringServer() } as Parameters<typeof desktopCatalog>[0]).models
    expect(open.filter((m) => m.unmeasured).map((m) => m.id).sort()).toEqual(UNMEASURED)
  })

  it('a copy saved from an older server loses them when it loads', () => {
    const merge = useCloudCatalogStore.persist.getOptions().merge!
    const merged = merge({ models: oldServer() }, useCloudCatalogStore.getState()) as { models: CloudModel[] }
    for (const id of UNMEASURED) expect(merged.models.map((m) => m.id), id).not.toContain(id)
    expect(merged.models.map((m) => m.id)).toContain('tripo-p2-image')
  })

  it('a server with its measurement switch on gets them shown', () => {
    useCloudCatalogStore.setState({ models: measuringServer() })
    const ids = shown()
    for (const id of UNMEASURED) expect(ids, id).toContain(id)
  })

  it('the rule itself', () => {
    expect(unmeasuredHidden({ id: 'hi3d-3.0-image' })).toBe(true)
    expect(unmeasuredHidden({ id: 'hi3d-3.0-image', unmeasured: true })).toBe(false)
    expect(unmeasuredHidden({ id: 'tripo-p2-image' })).toBe(false)
    expect(unmeasuredHidden({ id: 'flux-schnell' })).toBe(false)
  })
})
