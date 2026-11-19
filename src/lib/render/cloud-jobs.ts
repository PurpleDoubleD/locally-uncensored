// Desktop port: shared render types + intent mapping. The HTTP client (upload/
// submit/poll/cancel against lu-labs.ai) lives in api/cloud/jobs.ts.

// intentToJob's parameter, kept as a LOCAL literal union rather than an
// `import type { CreateIntent } from '../../stores/createStore'`. createStore
// now imports the cloud catalog (cloudCatalogStore, itself typed against
// RenderKind/RenderOp from this file) for addToGallery's backend gate, and a
// type-only import back to createStore here would close that into a module
// cycle (`npm run cycles`, madge, counts type-only edges too). The two sets
// must be kept in sync by hand; CreateIntent in stores/createStore.ts is the
// source of truth. Exported for create-studio.ts, which createStore imports
// too and which therefore cannot name CreateIntent either.
export type CreateIntentLike =
  | 'image' | 'edit' | 'removebg' | 'video' | 'animate' | 'upscale' | 'eraser'
  | 'character' | 'lipsync' | 'music' | 'extend' | 'motion' | '3d' | 'swap_character' | 'scene'

// '3d' (3.1.0): a GLB model. Cloud 3D runs as op 'studio' only.
export type RenderKind = 'image' | 'video' | 'audio' | '3d'
// 'upscale'/'eraser' are hosted utility endpoints (super-resolution /
// masked object removal) — cloud-only intents in the Create UI since 2.5.7.
// 2.5.8 adds the specialized ops behind the new Create categories: 'lipsync'
// (talking character), 'extend' (continue a clip), 'motion' (motion transfer,
// NOT face-swap — banned), 'music', 'tts' and 'lora-train' (Character-Studio).
// 'studio' (2026-09): the guided Create-Studio path, a schema-driven
// endpoint booked with `studio_options` and a server-confirmed quote, rather
// than one of the fixed param shapes above.
export type RenderOp =
  | 'generate' | 'edit' | 'removebg' | 'animate' | 'upscale' | 'eraser'
  | 'studio' | 'lipsync' | 'extend' | 'motion' | 'music' | 'tts' | 'lora-train'

// One shared compute-credit wallet — text + media draw from the same budget
// (server shape: the web app /api/jobs/quota).
//
// `topup`, `video` and `trainings` have been on the wire for a long time;
// they are optional here because an older server does not send them, and the
// meter must read an absent field as "uncapped" rather than as zero. See
// credits-meter.ts for the rule both the chip and the Create gate follow.
export interface CloudQuota {
  tier: string
  period: string
  limits: { credits: number }
  costs: { image: number; video: number }
  used: { credits_used: number }
  remaining: { credits: number }
  /** Non-expiring wallet, spent only after the monthly allowance. Exempt from
   *  the video sub-budget, so it extends video room. */
  topup?: { credits: number }
  /** Monthly video sub-budget. `remaining` is the MONTHLY share only. */
  video?: { limit: number; used: number; remaining: number }
  /** Monthly included character-training count. A wallet with at least the
   *  cost of the selected trainer unlocks an additional metered run. */
  trainings?: { limit: number; used: number; remaining: number }
}

/** The flat fallback price of the quota a kind is counted under when the
 *  server sent no own price. Audio and 3D have none in `costs` and count as an
 *  image; a 3D run is a studio pick and always carries a server quote. */
export function quotaCostKind(kind: RenderKind): 'image' | 'video' {
  return kind === 'video' ? 'video' : 'image'
}

/** Which queue kind + workflow op a Create intent renders as.
 *  'character' maps per characterTab (train vs use) — see useCloudCreate; the
 *  default here is the training op, the use-surface submits a plain image
 *  generate with a `loras` reference. */
export function intentToJob(intent: CreateIntentLike): { kind: RenderKind; op: RenderOp } {
  switch (intent) {
    case 'edit':
      return { kind: 'image', op: 'edit' }
    case 'removebg':
      return { kind: 'image', op: 'removebg' }
    case 'upscale':
      return { kind: 'image', op: 'upscale' }
    case 'eraser':
      return { kind: 'image', op: 'eraser' }
    case 'video':
      return { kind: 'video', op: 'generate' }
    case 'animate':
      return { kind: 'video', op: 'animate' }
    case 'character':
      return { kind: 'image', op: 'lora-train' }
    case 'lipsync':
      return { kind: 'video', op: 'lipsync' }
    case 'music':
      return { kind: 'audio', op: 'music' }
    case 'extend':
      return { kind: 'video', op: 'extend' }
    case 'motion':
      return { kind: 'video', op: 'motion' }
    case '3d':
      // Every cloud 3D model is a studio model (C3D 2.5): no op of its own.
      return { kind: '3d', op: 'studio' }
    // Swap Character runs studio models only (op 'studio' at submit). The op
    // here says which inputs are gathered: a video, as for Motion.
    case 'swap_character':
      return { kind: 'video', op: 'motion' }
    // Scene to Video (3.1.3) runs only studio models; its inputs are its own
    // (hooks/useCloudCreate.ts, the scene block), none of the shared op paths.
    case 'scene':
      return { kind: 'video', op: 'studio' }
    default:
      return { kind: 'image', op: 'generate' }
  }
}

/** The neutral gallery-entry shape a finished cloud job produces before the
 *  caller layers its own fields on top (prompt, label, and, for the
 *  Composer's classic path, the actual local render params: sampler, steps,
 *  seed, cfgScale, width, height, intent).
 *
 *  Web equivalent: lib/render/cloud-jobs.ts's `galleryItemFromJob`, which P5
 *  did not port (studio-p5.md, "Offen fuer P9"). It ended up built twice
 *  independently instead: once in PresetWorkshop.tsx (P6) and once inline in
 *  useCloudCreate.ts (P7). P9 folds both into this single function, the one
 *  place the portplan names for it.
 *
 *  Typed structurally against the job fields it actually reads, not against
 *  `CloudJob` from api/cloud/jobs.ts: that file already imports RenderKind/
 *  RenderOp FROM this one, so a type import back here would close a module
 *  cycle (same reasoning as CreateIntentLike above). */
export function galleryItemFromJob(job: {
  id: string
  kind: RenderKind
  model: string
  result_url: string | null
  attestation: { quote: string; verify_url: string } | null
}) {
  return {
    id: job.id,
    type: job.kind,
    filename: '',
    subfolder: '',
    negativePrompt: '',
    model: job.model,
    modelType: 'unknown' as const,
    seed: 0,
    steps: 0,
    cfgScale: 0,
    sampler: '',
    scheduler: '',
    width: 0,
    height: 0,
    batchSize: 1,
    createdAt: Date.now(),
    remoteUrl: job.result_url ?? undefined,
    attestation: job.attestation,
    jobId: job.id,
  }
}
