// What the 3D row of the Composer offers for the model that will run
// (C3D-PLAN 1.2, 2.5). Local: one picture, a detail step, LU's own cutout.
// Cloud: a studio model says in its own entry how many pictures it takes
// (`images -> image_paths` with the schema's maxItems) and which field its
// detail step moves; the provider cuts out the object itself.
import type { CreateBackend, ThreeDDetail } from '../../stores/createStore'
import { STUDIO_MODELS, studioSchema } from '../render/studio-contract'

export interface ThreeDControlFacts {
  maxViews: number
  hasDetail: boolean
  hasCutout: boolean
}

/** At most four sides: Front, Left, Back, Right. */
const MAX_SIDES = 4

export function threeDMaxViews(studioId: string | undefined): number {
  const m = studioId ? STUDIO_MODELS[studioId] : undefined
  if (!m) return 1
  const field = Object.entries(m.inputs).find(([, role]) => role === 'image_paths')?.[0]
  if (!field) return 1
  let max = MAX_SIDES
  try {
    max = studioSchema(studioId!).properties?.[field]?.maxItems ?? MAX_SIDES
  } catch {
    // An entry without a schema takes the four sides the tab draws.
  }
  return Math.max(1, Math.min(MAX_SIDES, max))
}

/** The field of a cloud 3D model that its Detail step moves, with the value
 *  of each step. Read from the schema's choices: the first, middle and last
 *  value of the field the price runs over. */
export function threeDDetailField(studioId: string | undefined): { field: string; values: Record<ThreeDDetail, unknown> } | null {
  const m = studioId ? STUDIO_MODELS[studioId] : undefined
  if (!m) return null
  const field = m.price.resolutionField ?? (m.price.rates && Object.keys(m.price.rates).length > 1 ? 'resolution' : undefined)
  if (!field) return null
  let choices: unknown[] | undefined
  let fallback: unknown
  try {
    const prop = studioSchema(studioId!).properties?.[field]
    choices = prop?.enum
    fallback = prop?.default
  } catch {
    return null
  }
  if (!choices || choices.length < 2) return null
  // A schema lists its choices in any order (Tripo: standard, detailed,
  // extreme, fast; Meshy: texture on, off). When the price runs over the
  // field, cheapest is Draft and dearest is Fine; of equal prices the first
  // listed stays. Standard is the model's own default, else the middle one.
  const rates = m.price.rates ?? {}
  const priced = choices.every((c) => typeof rates[String(c)] === 'number')
  if (priced) {
    const seen = new Set<number>()
    choices = [...choices]
      .sort((a, b) => rates[String(a)] - rates[String(b)])
      .filter((c) => (seen.has(rates[String(c)]) ? false : (seen.add(rates[String(c)]), true)))
    if (choices.length < 2) return null
  }
  const mid = priced && choices.includes(fallback) ? fallback : choices[Math.floor((choices.length - 1) / 2)]
  return { field, values: { draft: choices[0], standard: mid, fine: choices[choices.length - 1] } }
}

/** Which step a cloud model's field stands on: its value, else the schema's
 *  default, else Standard. */
export function cloudDetailOf(f: { field: string; values: Record<ThreeDDetail, unknown> }, value: unknown, studioId: string | undefined): ThreeDDetail {
  let v = value
  if (v === undefined && studioId) {
    try { v = studioSchema(studioId).properties?.[f.field]?.default } catch { v = undefined }
  }
  const hit = (Object.keys(f.values) as ThreeDDetail[]).find((d) => f.values[d] === v)
  return hit ?? 'standard'
}

export function threeDControlFacts(backend: CreateBackend, studioId: string | undefined): ThreeDControlFacts {
  if (backend === 'local') return { maxViews: 1, hasDetail: true, hasCutout: true }
  return { maxViews: threeDMaxViews(studioId), hasDetail: !!threeDDetailField(studioId), hasCutout: false }
}
