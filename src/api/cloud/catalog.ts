// GET /api/jobs/catalog — the server-authoritative render/voice catalog
// (models, per-op credit costs, media-live switch). Pure HTTP; the persisted
// cache + fallback ordering live in stores/cloudCatalogStore.

import { cloudFetch, jsonOrError } from './client'
import type { CloudModel } from '../../lib/render/cloud-models'

export interface CatalogOps {
  removebg: number
  eraser: number
  upscale_image: number
  // Per-target image-upscale rates (2k/4k/8k). Optional: older catalog
  // payloads (persisted cache) carry only the flat 4k figure above.
  upscale_image_res?: Record<string, number>
  upscale_video_per_s: number
  upscale_video_min: number
}

export interface CloudCatalog {
  models: CloudModel[]
  ops: CatalogOps
  voice: { stt: number; tts_per_1k_chars: number }
  media_live: boolean
  tier: string
  monthly_credits: number
  /** Largest file /api/jobs/upload takes, in bytes per kind. Optional: a
   *  server that does not send it leaves the client's own limits in place
   *  (lib/upload-limits.ts). */
  upload_limits?: { image?: number; audio?: number; video?: number }
}

/** A catalog entry as the server sends it. `native_label` is the app's own
 *  name for an entry the cloud lists under a neutral name on its own domain
 *  (the open media models). Absent on every other entry and on a server that
 *  does not send the field yet. */
type WireModel = CloudModel & { native_label?: unknown }

/** The catalog as the app shows it: where the server names an entry for the
 *  app, that name is the label. This is the one place the two names meet, so
 *  the store, its persisted copy and every picker, shelf and gallery line
 *  read the app's name without knowing there was another. */
export function desktopCatalog(wire: Omit<CloudCatalog, 'models'> & { models: WireModel[] }): CloudCatalog {
  return {
    ...wire,
    models: wire.models.map(({ native_label, ...m }) =>
      typeof native_label === 'string' && native_label.trim() ? { ...m, label: native_label } : m,
    ),
  }
}

export async function getCatalog(): Promise<CloudCatalog> {
  // v=2: this build understands op-specialized models (trainers, lipsync,
  // voice, music, extend, motion) — without the flag the server serves only
  // the classic list so pre-2.5.8 clients never mis-list them.
  //
  // P3: no query bump for Studio. A server that knows Studio simply adds
  // `api_schema`/`pricing`/`quote_required` to the entries this same v=2
  // response already carries, and cloudCatalogStore/runCredits key off the
  // PRESENCE of those fields, never a version number (portplan Abschnitt 4/7).
  // 3.1.0: `with=3d` asks for the 3D models too. A server hands them only to
  // an app that asks, so an app before 3.1.0 never draws a GLB as a broken
  // picture.
  const res = await cloudFetch('/api/jobs/catalog?v=2&with=3d')
  return desktopCatalog(await jsonOrError<Parameters<typeof desktopCatalog>[0]>(res))
}
