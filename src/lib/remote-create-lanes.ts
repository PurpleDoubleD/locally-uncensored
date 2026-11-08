/**
 * Create over the desktop, stage 2 (mobile-docs/remote/CREATE-V2.md): the
 * kinds beyond a plain image or clip, on this computer's own engines, with
 * the same functions the Create tab runs them with (hooks/useCreate.ts):
 *
 *   Mac (MLX)            edit and image to image: an edit pack of the second
 *                        image engine (generateMlxImageDataUrl with images),
 *                        upscale: SeedVR2 (upscaleOnMac), removebg: Vision
 *                        (cutOutOnMac), music: ACE-Step (runMacMusic).
 *   ComfyUI              edit: buildDynamicWorkflow with the source, the
 *                        references and the mask (through image_generate's
 *                        hand-off, see remote-create-runner), upscale:
 *                        buildLocalUpscaleWorkflow, removebg: the RMBG graph
 *                        of buildDynamicWorkflow, music: buildLocalOpWorkflow,
 *                        the last three through vramHandoffLane.
 *
 * What a kind cannot do on this machine is said in `capabilities` with a
 * reason, never left to fail later. A lane answers with the result line the
 * media tools use: a file:// line for a file of the Mac, a ComfyUI /view URL
 * otherwise. Rust decides whether that file may leave the machine.
 */
import { pathToFileUrl } from './local-media-url'

export type LaneKind = 'image' | 'image-to-image' | 'video' | 'image-to-video' | 'edit' | 'upscale' | 'removebg' | 'music'

/** One staged input as Rust hands it over. */
export interface LaneInput {
  input_path?: string
  input_comfy_name?: string
  width?: number
  height?: number
}

export interface LaneJob {
  id: string
  kind: LaneKind
  prompt: string
  negative: string
  model: string | null
  width: number | null
  height: number | null
  steps: number | null
  seed: number | null
  factor?: number | null
  lyrics?: string | null
  duration?: number | null
  inputs?: LaneInput[]
  mask?: LaneInput | null
  conversation_id: string
}

export interface LaneWatch {
  /** A fraction of the run and/or a short line. */
  report: (fraction: number | null, text: string | null) => void
  signal: AbortSignal
}

export interface ModelEntry {
  id: string
  name: string
  width?: number
  height?: number
  recommended_max?: number
  note?: string
}

export interface KindCaps {
  models: ModelEntry[]
  available?: boolean
  reason?: string
  character?: boolean
  max_inputs?: number
  duration?: { min: number; max: number; default?: number }
}

export interface LaneCaps {
  kinds: Partial<Record<LaneKind, KindCaps>>
  characters?: { id: string; name: string; model_family: string; trigger: string }[]
  engine_ready?: boolean
}

/** Music lengths both engines take (lib/mac-music, createStore). */
export const MUSIC_DEFAULT_SECONDS = 60
const COMFY_MUSIC_MIN = 5
const COMFY_MUSIC_MAX = 240

/** The most references an edit takes from a phone (CREATE-V2.md). */
export const REMOTE_MAX_EDIT_INPUTS = 5

const pick = (m: { name: string }) => ({ id: m.name, name: m.name })

/** Above this an SD 1.5 picture gets slow and repeats itself. */
export const SD15_RECOMMENDED_MAX = 768
export const SD15_NOTE = 'SD 1.5 models are made for 512 x 512. Above 768 a picture takes much longer and often repeats parts of itself.'

/** The family defaults of the desktop's Create tab (api/comfyui.ts). */
interface SizeDefaults {
  classifyModel: (name: string) => string
  MODEL_TYPE_DEFAULTS: Record<string, { width: number; height: number }>
}

/**
 * An image model for the phone with the size its family starts at on the
 * desktop (SD 1.5 at 512, SDXL and Flux at 1024), and for SD 1.5 the size
 * above which it gets slow. Pure + exported for tests.
 */
export function imageModelEntry(defaults: SizeDefaults, m: { name: string; type?: string }): ModelEntry {
  const type = m.type && m.type !== 'unknown' ? m.type : defaults.classifyModel(m.name)
  const d = defaults.MODEL_TYPE_DEFAULTS[type] ?? defaults.MODEL_TYPE_DEFAULTS.unknown
  const entry: ModelEntry = { id: m.name, name: m.name }
  if (d) { entry.width = d.width; entry.height = d.height }
  if (type === 'sd15') { entry.recommended_max = SD15_RECOMMENDED_MAX; entry.note = SD15_NOTE }
  return entry
}

export const MAC_REASONS = {
  edit: 'No model that edits images is installed on your computer. Install Qwen-Image 2.1 in the Model Manager on your computer.',
  upscale: 'No model that enhances images is installed on your computer. Install SeedVR2 3B in the Model Manager on your computer.',
  music: 'The music engine is not installed on your computer. Get ACE-Step 1.5 in the Model Manager on your computer, under Music.',
} as const

export const COMFY_REASONS = {
  offline: 'ComfyUI is not running on your computer yet. Try again in a moment.',
  image: 'No image model is installed on your computer. Install one in Create on your computer.',
  upscale: 'No upscale model is installed on your computer. Install one in Create, Enhance Image, on your computer.',
  removebg: 'The background removal node (ComfyUI-RMBG) is not installed on your computer. Install it in Create, Remove Background, on your computer.',
  music: 'No music model is installed on your computer. Install ACE Step in Create, Music, on your computer.',
} as const

/** A file of this machine as a result line. */
function fileLine(label: string, path: string | undefined, prompt = ''): string {
  if (!path) return `Error: ${label} generation completed but no output produced.`
  const name = path.split(/[\\/]/).pop() || path
  return `${label} generated: ${name} (prompt: "${prompt}")\n${pathToFileUrl(path)}`
}

function errorLine(e: unknown): string {
  return `Error: ${e instanceof Error ? e.message : String(e)}`
}

/** The characters of this machine as the phone lists them. */
async function characterList(): Promise<NonNullable<LaneCaps['characters']>> {
  try {
    const { listLocalCharacters } = await import('./characters')
    const list = await listLocalCharacters()
    return list.map((c) => ({ id: c.id, name: c.name, model_family: c.family, trigger: c.triggerWord }))
  } catch {
    return []
  }
}

// ── Mac ──────────────────────────────────────────────────────────────────

export async function macCapabilities(): Promise<LaneCaps> {
  const [{ listMlxImageModels, mlxUpscalerInstalled }, { isMlxEnhancer }, video, music] = await Promise.all([
    import('../api/mlx-image'), import('./image-engines'), import('../api/mlx-video'), import('../api/mlx-music'),
  ])
  const catalog = await listMlxImageModels().catch(() => [])
  const images = catalog.filter((m) => m.installed && !isMlxEnhancer(m) && m.upscaler !== true)
  const edits = images.filter((m) => (m.editImages ?? 0) > 0)
  const loras = images.some((m) => m.loras === true)
  const clips = await video.listVideoModels().then((l) => l.filter((m) => m.installed)).catch(() => [])
  const musicReady = await music.getMusicStatus().then((s) => s.installed).catch(() => false)
  const upscaler = mlxUpscalerInstalled(catalog)
  const characters = loras ? await characterList() : []
  const maxInputs = Math.min(REMOTE_MAX_EDIT_INPUTS, Math.max(1, ...edits.map((m) => m.editImages ?? 1)))
  const editCaps = (): KindCaps => ({
    models: edits.map(pick),
    available: edits.length > 0,
    ...(edits.length ? {} : { reason: MAC_REASONS.edit }),
  })
  const startClips = clips.filter((m) => video.mlxVideoStartImage(m) !== 'none')
  const comfy = await import('../api/comfyui')
  // The Mac's engine picks its own size for a model it does not name a
  // family for; only a known family gets a size here.
  const sized = (m: { name: string }) => (comfy.classifyModel(m.name) === 'unknown' ? pick(m) : imageModelEntry(comfy, m))
  return {
    engine_ready: true,
    characters,
    kinds: {
      image: { models: images.map(sized), character: loras },
      // A character's clip starts from its picture on the second engine.
      video: { models: clips.filter((m) => !m.requiresImage).map(pick), character: loras && startClips.length > 0 },
      'image-to-video': { models: startClips.map(pick) },
      'image-to-image': { ...editCaps(), max_inputs: 1 },
      edit: { ...editCaps(), max_inputs: maxInputs },
      upscale: upscaler
        ? { models: [{ id: 'SeedVR2 3B', name: 'SeedVR2 3B' }], available: true }
        : { models: [], available: false, reason: MAC_REASONS.upscale },
      // Vision in macOS: nothing to install.
      removebg: { models: [], available: true },
      music: musicReady
        ? { models: [{ id: music.MAC_MUSIC_MODEL_NAME, name: music.MAC_MUSIC_MODEL_NAME }], available: true, duration: { min: music.MAC_MUSIC_MIN_SECONDS, max: music.MAC_MUSIC_MAX_SECONDS, default: MUSIC_DEFAULT_SECONDS } }
        : { models: [], available: false, reason: MAC_REASONS.music },
    },
  }
}

/** The chat model leaves memory for a heavy run and comes back after it,
 *  as in Create (freeMacMemoryForRender). */
async function withMacMemory<T>(watch: LaneWatch, run: () => Promise<T>): Promise<T> {
  const { evictChatBackendsForRender, restoreChatBackendsAfterRender } = await import('../api/vram-handoff')
  let eviction: Awaited<ReturnType<typeof evictChatBackendsForRender>> | null = null
  try {
    watch.report(null, 'Freeing memory for the model')
    eviction = await evictChatBackendsForRender().catch(() => null)
    return await run()
  } finally {
    if (eviction) void restoreChatBackendsAfterRender(eviction)
  }
}

export async function runLaneOnMac(job: LaneJob, watch: LaneWatch): Promise<string> {
  const inputs = (job.inputs ?? []).filter((i) => !!i.input_path)
  const source = inputs[0]?.input_path
  try {
    switch (job.kind) {
      case 'removebg': {
        if (!source) return 'Error: Add an image to remove its background.'
        const { cutOutOnMac } = await import('../api/mlx-image')
        watch.report(0.3, 'Cutting out the subject')
        const made = await cutOutOnMac(source)
        return fileLine('Image', made.localPath)
      }
      case 'upscale': {
        if (!source) return 'Error: Add an image to enhance.'
        const { upscaleOnMac, listMlxImageModels, mlxUpscalerInstalled } = await import('../api/mlx-image')
        if (!mlxUpscalerInstalled(await listMlxImageModels().catch(() => []))) return `Error: ${MAC_REASONS.upscale}`
        const scale = job.factor === 4 ? 4 : 2
        const made = await withMacMemory(watch, () => upscaleOnMac(source, { scale, ...(job.seed != null ? { seed: job.seed } : {}) }, {
          signal: watch.signal,
          onStep: (step, of) => watch.report(of > 0 ? step / of : null, `Enhancing ${scale}x, step ${step} of ${of}`),
        }))
        return fileLine('Image', made.localPath)
      }
      case 'edit':
      case 'image-to-image':
        return await macEdit(job, inputs, watch)
      case 'music': {
        const music = await import('../api/mlx-music')
        if (!(await music.getMusicStatus().then((s) => s.installed).catch(() => false))) return `Error: ${MAC_REASONS.music}`
        const seconds = music.macMusicSeconds(job.duration ?? MUSIC_DEFAULT_SECONDS)
        try {
          const track = await withMacMemory(watch, () => music.runMacMusic(
            { prompt: job.prompt, lyrics: job.lyrics ?? '', seconds, seed: job.seed ?? -1 },
            { signal: watch.signal, onProgress: (percent, text) => watch.report(percent / 100, text) },
          ))
          return fileLine('Music', track.output, job.prompt)
        } catch (e) {
          if (e instanceof music.MusicRunCancelled) return 'Music generation cancelled.'
          throw e
        }
      }
      default:
        return `Error: ${job.kind} does not run as a lane.`
    }
  } catch (e) {
    return errorLine(e)
  }
}

/** Edit on the second image engine, sized the way Create sizes it. */
async function macEdit(job: LaneJob, inputs: LaneInput[], watch: LaneWatch): Promise<string> {
  const [mlx, { isMlxEnhancer, editCanvas, macEditCanvas, macEditSide }, { extraReferenceSlots, referenceSide }, { qwenEditResolution }] = await Promise.all([
    import('../api/mlx-image'), import('./image-engines'), import('./edit-references'), import('../api/dynamic-workflow'),
  ])
  if (!inputs.length) return 'Error: Add a source image first.'
  if (!job.prompt.trim()) return 'Error: Please enter a prompt.'
  const catalog = (await mlx.listMlxImageModels()).filter((m) => m.installed && !isMlxEnhancer(m) && m.upscaler !== true && (m.editImages ?? 0) > 0)
  const model = catalog.find((m) => m.name === job.model || mlx.mlxDisplayName(m) === job.model) ?? catalog[0]
  if (!model) return `Error: ${MAC_REASONS.edit}`
  const type = mlx.mlxModelType(model)
  // The source, then as many references as the model reads.
  const room = Math.max(1, Math.min(model.editImages ?? 1, 1 + extraReferenceSlots(type, model.name)))
  const refs = inputs.slice(0, job.kind === 'edit' ? room : 1)
  const budget = qwenEditResolution(job.width ?? 1024, job.height ?? 1024)
  const side = macEditSide(referenceSide(budget, refs.length))
  const src = refs[0]
  const size = refs.length > 1 ? macEditCanvas(editCanvas(budget, { width: src.width ?? 0, height: src.height ?? 0 })) : null
  const mask = job.kind === 'edit' ? job.mask?.input_path : undefined
  const made = await withMacMemory(watch, () => mlx.generateMlxImageDataUrl({
    prompt: job.prompt,
    model: model.id,
    ...(job.steps ? { steps: job.steps } : {}),
    ...(job.seed != null ? { seed: job.seed } : {}),
    images: refs.map((r) => r.input_path as string),
    resolution: side,
    ...(size ?? {}),
    ...(mask ? { mask, strength: 1 } : {}),
    ...(job.negative ? { negativePrompt: job.negative } : {}),
  }, {
    signal: watch.signal,
    onStep: (step, of) => watch.report(of > 0 ? step / of : null, `Step ${step} of ${of}`),
  }))
  return fileLine('Image', made.localPath, job.prompt)
}

// ── ComfyUI ──────────────────────────────────────────────────────────────

export async function comfyCapabilities(): Promise<LaneCaps> {
  const comfy = await import('../api/comfyui')
  let images: { name: string; type: string }[]
  let videos: { name: string }[]
  try {
    [images, videos] = await Promise.all([comfy.getImageModels(), comfy.getVideoModels()])
  } catch {
    // ComfyUI is not running yet. An image or a clip still starts it, the
    // rest waits for the list.
    const off = { models: [], available: false, reason: COMFY_REASONS.offline }
    return { engine_ready: false, kinds: { edit: off, upscale: off, removebg: off, music: off } }
  }
  const [{ getAllNodeInfo }, { extraReferenceSlots }] = await Promise.all([import('../api/comfyui-nodes'), import('./edit-references')])
  const [upscalers, audio, nodes, characters] = await Promise.all([
    comfy.getUpscaleModels().catch(() => [] as string[]),
    comfy.getAudioModels().catch(() => []),
    getAllNodeInfo().catch(() => ({}) as Record<string, unknown>),
    characterList(),
  ])
  const rmbg = 'RMBG' in nodes
  const maxInputs = Math.min(REMOTE_MAX_EDIT_INPUTS, 1 + Math.max(0, ...images.map((m) => extraReferenceSlots(m.type as never, m.name))))
  const imageCaps = images.length ? {} : { available: false, reason: COMFY_REASONS.image }
  const sized = (m: { name: string; type: string }) => imageModelEntry(comfy, m)
  return {
    engine_ready: true,
    characters,
    kinds: {
      image: { models: images.map(sized), character: true },
      'image-to-image': { models: images.map(sized), ...imageCaps },
      edit: { models: images.map(pick), max_inputs: maxInputs, ...imageCaps },
      video: { models: videos.filter((m) => comfy.isT2VCapable(m.name)).map(pick), character: videos.some((m) => comfy.isI2VModel(m.name)) },
      'image-to-video': { models: videos.filter((m) => comfy.isI2VModel(m.name)).map(pick) },
      upscale: upscalers.length
        ? { models: upscalers.map((n) => ({ id: n, name: n })), available: true }
        : { models: [], available: false, reason: COMFY_REASONS.upscale },
      removebg: rmbg ? { models: [], available: true } : { models: [], available: false, reason: COMFY_REASONS.removebg },
      music: audio.length
        ? { models: audio.map(pick), available: true, duration: { min: COMFY_MUSIC_MIN, max: COMFY_MUSIC_MAX, default: MUSIC_DEFAULT_SECONDS } }
        : { models: [], available: false, reason: COMFY_REASONS.music },
    },
  }
}

export async function runLaneOnComfy(job: LaneJob): Promise<string> {
  const source = job.inputs?.[0]
  const name = source?.input_comfy_name
  try {
    const [{ vramHandoffLane }, comfy, dyn] = await Promise.all([
      import('../api/vram-handoff'), import('../api/comfyui'), import('../api/dynamic-workflow'),
    ])
    switch (job.kind) {
      case 'upscale': {
        if (!name) return 'Error: Add an image to enhance.'
        const { pickUpscaleModel, normalizeUpscaleFactor, upscaleTooLargeLine } = await import('./local-upscale')
        const list = await comfy.getUpscaleModels().catch(() => [] as string[])
        const model = job.model && list.includes(job.model) ? job.model : pickUpscaleModel(list)
        if (!model) return `Error: ${COMFY_REASONS.upscale}`
        const factor = normalizeUpscaleFactor(job.factor ?? 2)
        const tooLarge = upscaleTooLargeLine(source?.width ?? 0, source?.height ?? 0, factor)
        if (tooLarge) return `Error: ${tooLarge}`
        return await vramHandoffLane({
          kind: 'image', label: 'Image', model, prompt: '',
          build: () => dyn.buildLocalUpscaleWorkflow({ image: name, model, factor, sourceWidth: source?.width ?? 0, sourceHeight: source?.height ?? 0 }),
        }, job.conversation_id)
      }
      case 'removebg': {
        if (!name) return 'Error: Add an image to remove its background.'
        return await vramHandoffLane({
          kind: 'image', label: 'Image', model: '', prompt: '',
          build: () => dyn.buildDynamicWorkflow({
            prompt: '', negativePrompt: '', model: '', sampler: '', scheduler: '', steps: 1, cfgScale: 1,
            width: source?.width ?? 1024, height: source?.height ?? 1024, seed: 0, batchSize: 1,
            removebg: true, inputImage: name,
          }),
        }, job.conversation_id)
      }
      case 'music': {
        if (!job.prompt.trim()) return 'Error: Describe the track first. Genre, mood, tempo.'
        const list = await comfy.getAudioModels().catch(() => [])
        const model = list.find((m) => m.name === job.model)?.name ?? list[0]?.name
        if (!model) return `Error: ${COMFY_REASONS.music}`
        const type = comfy.classifyModel(model)
        const d = comfy.MODEL_TYPE_DEFAULTS[type] ?? comfy.MODEL_TYPE_DEFAULTS.unknown
        const seconds = Math.min(COMFY_MUSIC_MAX, Math.max(COMFY_MUSIC_MIN, Math.round(job.duration ?? MUSIC_DEFAULT_SECONDS)))
        return await vramHandoffLane({
          kind: 'video', label: 'Music', model, prompt: job.prompt,
          build: () => dyn.buildLocalOpWorkflow({
            op: 'music', model, prompt: job.prompt, negativePrompt: '',
            seed: job.seed ?? -1, steps: d.steps, cfgScale: d.cfg, sampler: d.sampler, scheduler: d.scheduler,
            width: d.width, height: d.height, frames: d.frames, fps: d.fps,
            seconds, lyrics: job.lyrics ?? '',
          }),
        }, job.conversation_id)
      }
      default:
        return `Error: ${job.kind} does not run as a lane.`
    }
  } catch (e) {
    return errorLine(e)
  }
}

// ── Gallery ──────────────────────────────────────────────────────────────

/** A desktop gallery entry as Rust reads it (remote_create.rs gallery_entries). */
export interface GalleryOut {
  key: string
  media: 'image' | 'video' | 'audio'
  path?: string
  comfy_filename?: string
  comfy_subfolder?: string
  prompt: string
  model: string
  created_at: number
  from_phone: boolean
}

export const FROM_YOUR_PHONE = 'From your phone'

/** The entries of the desktop gallery that are files on this machine. A
 *  cloud entry or one that only lives in memory has none and is left out. */
export function galleryForRemote(items: readonly {
  id: string; type: 'image' | 'video' | 'audio'; filename: string; subfolder: string; comfyType?: string
  localPath?: string; remoteUrl?: string; prompt: string; model: string; createdAt: number; label?: string
  hidden?: boolean
}[]): GalleryOut[] {
  const out: GalleryOut[] = []
  for (const it of items) {
    // Hidden on the computer (D27, 3.1.0): not shown on the phone either.
    if (it.hidden) continue
    const base = { key: it.id, media: it.type, prompt: it.prompt ?? '', model: it.model ?? '', created_at: it.createdAt ?? 0, from_phone: it.label === FROM_YOUR_PHONE }
    if (it.localPath) out.push({ ...base, path: it.localPath })
    else if (!it.remoteUrl && it.filename && (it.comfyType ?? 'output') === 'output') out.push({ ...base, comfy_filename: it.filename, comfy_subfolder: it.subfolder ?? '' })
  }
  return out.slice(0, 2000)
}
