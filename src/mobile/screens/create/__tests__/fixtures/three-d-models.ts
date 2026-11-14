/**
 * Three cloud 3D models for the tests of the phone, one per way, after the
 * first wave of the plan (C3D-PLAN 3.3). The real entries come with the
 * studio registry later; until then a test adds these and takes them out
 * again. Endpoints are stand ins, prices are only the shape of the real ones.
 *
 * Used by the unit tests here and by e2e/mobile/create.mobile.ts, which
 * serves the same entries to the app in place of the registry files.
 */
import type { Schema, StudioModel } from '../../../../../lib/render/studio-contract'

export const MESH_IMAGE = 'trellis-2'
export const MESH_TEXT = 'hunyuan3d-3.1-rapid-text'
export const MESH_VIEWS = 'tripo-h3.1-multiview'

export const THREE_D_STUDIO: Record<string, StudioModel> = {
  [MESH_IMAGE]: {
    label: 'TRELLIS.2', endpoint: 'test/trellis-2/image-to-3d', kind: '3d', adult: false, tier: 'best', weights: 'open', typical_s: 40,
    inputs: { image: 'source_path' }, defaults: {}, baselineUsd: 0.2,
    price: { mode: 'flat', rates: { '512': 0.1, '1024': 0.2, '1536': 0.4 }, resolutionField: 'resolution' },
  },
  [MESH_TEXT]: {
    label: 'Hunyuan3D 3.1 Rapid', endpoint: 'test/hunyuan-3d/text-to-3d', kind: '3d', adult: false, tier: 'standard', weights: 'open-family', typical_s: 110,
    inputs: {}, defaults: {}, baselineUsd: 0.27,
    price: { mode: 'flat', rates: { default: 0.27 } },
  },
  [MESH_VIEWS]: {
    label: 'Tripo H3.1 Multiview', endpoint: 'test/tripo/multiview-to-3d', kind: '3d', adult: false, tier: 'standard', weights: 'closed', typical_s: 130,
    inputs: { images: 'image_paths' }, defaults: {}, baselineUsd: 0.36,
    price: { mode: 'flat', rates: { standard: 0.36, detailed: 0.48, extreme: 0.6 }, resolutionField: 'texture_quality', extraImage: 0 },
  },
}

export const THREE_D_SCHEMAS: Record<string, Schema> = {
  'test/trellis-2/image-to-3d': {
    type: 'object',
    required: ['image'],
    properties: {
      image: { type: 'string', format: 'uri' },
      resolution: { type: 'integer', enum: [512, 1024, 1536], default: 1024 },
      seed: { type: 'integer', minimum: -1, maximum: 2147483647, default: -1 },
    },
  },
  'test/hunyuan-3d/text-to-3d': {
    type: 'object',
    required: ['prompt'],
    properties: { prompt: { type: 'string' } },
  },
  'test/tripo/multiview-to-3d': {
    type: 'object',
    required: ['images'],
    properties: {
      images: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
      texture_quality: { type: 'string', enum: ['standard', 'detailed', 'extreme'], default: 'standard' },
    },
  },
}

/** The catalog entries the server sends for them (ops studio, the price confirmed by the server). */
export function threeDCatalogEntries(): { id: string; label: string; kind: '3d'; adult: boolean; ops: string[]; quote_required: boolean; tier: string; weights: string }[] {
  return Object.entries(THREE_D_STUDIO).map(([id, m]) => ({ id, label: m.label, kind: '3d', adult: m.adult, ops: ['studio'], quote_required: true, tier: m.tier, weights: m.weights }))
}

/** Put the three into the registry objects the app reads. Returns the undo.
 *  `withRetired` is STUDIO_MODELS_WITH_RETIRED: since the catalogue sync of
 *  3.1.0 it is an object of its own next to STUDIO_MODELS, and studioSchema
 *  reads the endpoint from it. The undo puts back what stood there before,
 *  because some of the three ids are real catalogue entries now. */
export function installThreeDStudio(models: Record<string, StudioModel>, schemas: Record<string, Schema>, withRetired?: Record<string, StudioModel>): () => void {
  const targets = withRetired && withRetired !== models ? [models, withRetired] : [models]
  const before = targets.map((t) => Object.fromEntries(Object.keys(THREE_D_STUDIO).map((id) => [id, t[id]])))
  const schemasBefore = Object.fromEntries(Object.keys(THREE_D_SCHEMAS).map((path) => [path, schemas[path]]))
  for (const t of targets) Object.assign(t, THREE_D_STUDIO)
  Object.assign(schemas, THREE_D_SCHEMAS)
  return () => {
    targets.forEach((t, i) => {
      for (const [id, m] of Object.entries(before[i])) {
        if (m) t[id] = m
        else delete t[id]
      }
    })
    for (const [path, sc] of Object.entries(schemasBefore)) {
      if (sc) schemas[path] = sc
      else delete schemas[path]
    }
  }
}
