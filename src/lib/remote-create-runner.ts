/**
 * Create over the desktop: the part of a phone's Create job that runs in this
 * window. No interface here; the bar that shows it is
 * components/layout/RemoteCreateBar.tsx.
 *
 * Rust keeps the job table (src-tauri/src/commands/remote_create.rs) and hands
 * a job over through the event `remote-create-job`. This file makes the media
 * with the same functions the chat tools use (`generateMediaForRemote` in
 * api/mcp/builtin-tools.ts, which calls executeImageGenerate and
 * executeVideoGenerate) for an image or a clip, a character and an edit on
 * ComfyUI; the other kinds of stage 2 (CREATE-V2.md) run in
 * lib/remote-create-lanes.ts with the functions of the Create tab. It reports
 * back through `remote_create_progress` and `remote_create_finish`, and
 * answers the questions for capabilities and the gallery. It reports what an engine says: ComfyUI's progress
 * events and the hand-off phases. It starts no timer of its own; a WebView in
 * the background is throttled, so Rust reads the Mac engines itself and fails
 * a job that goes quiet.
 *
 * What goes back is a path or a ComfyUI file name. Rust decides whether that
 * file is inside an output folder; nothing here is trusted for that.
 */
import { create } from 'zustand'
import { backendCall, isTauri } from '../api/backend'
import { fileUrlToPath } from './local-media-url'
import { isMediaFailureResult } from './media-result'
import { log } from './logger'
import { blockMessageFor, checkPromptSafety } from './render/safety'
import { FROM_YOUR_PHONE, type GalleryOut, type LaneCaps, type LaneInput, type LaneKind, type LaneWatch } from './remote-create-lanes'

export const REMOTE_CREATE_EVENT = 'remote-create-job'

export type RemoteCreateKind = LaneKind
export type RemoteCreateTool = 'mlx' | 'comfyui'

export interface RemoteCreateJob {
  id: string
  kind: RemoteCreateKind
  prompt: string
  negative: string
  model: string | null
  width: number | null
  height: number | null
  steps: number | null
  seed: number | null
  count: number
  conversation_id: string
  /** Mac: the uploaded start image on disk. */
  input_path?: string
  /** ComfyUI: the uploaded image, copied into ComfyUI's input folder. */
  input_comfy_name?: string
  /** Stage 2: every input in order (source first) with its size, and the
   *  mask of an edit. */
  inputs?: LaneInput[]
  mask?: LaneInput | null
  character?: string | null
  factor?: number | null
  lyrics?: string | null
  duration?: number | null
}

export interface RemoteCreateRunning {
  id: string
  kind: RemoteCreateKind
  prompt: string
  progress: number
  step_text: string
  count: number
}

export type RemoteCreateEvent =
  | { action: 'run'; job: RemoteCreateJob }
  | { action: 'cancel'; id: string; kind?: RemoteCreateKind }
  | { action: 'capabilities'; request_id: string }
  | { action: 'gallery'; request_id: string }
  | { action: 'state'; running: RemoteCreateRunning | null; queued: number }

/** A result as Rust takes it: a path, or a name in ComfyUI's output folder. */
export interface RemoteCreateOutput {
  path?: string
  comfyFilename?: string
  comfySubfolder?: string
}

export interface RemoteCreateModel { id: string; name: string }
export type RemoteCreateModels = LaneCaps

export interface RemoteCreateDeps {
  tool: RemoteCreateTool
  generate: (media: 'image' | 'video', args: Record<string, unknown>, conversationId: string) => Promise<string>
  /** The kinds of stage 2 that do not run as an image_generate call:
   *  upscale, removebg, music everywhere, edit and image to image on a Mac. */
  runLane: (job: RemoteCreateJob, watch: LaneWatch) => Promise<string>
  cancel: (conversationId: string, media: 'image' | 'video' | 'audio') => void
  listModels: () => Promise<RemoteCreateModels>
  desktopBusy: () => boolean
  /** The input image as the generation reads it, from what Rust staged. */
  inputRef: (job: RemoteCreateJob) => string | undefined
  /** Edit on ComfyUI: the further references and the mask as image_generate
   *  reads them (names in ComfyUI's input folder). */
  editArgs?: (job: RemoteCreateJob) => Record<string, unknown>
  progress: (id: string, p: { progress?: number; stepText?: string; index?: number }) => Promise<boolean>
  finish: (id: string, ok: boolean, error: string | null, outputs: RemoteCreateOutput[]) => Promise<unknown>
  replyCapabilities: (requestId: string, caps: Record<string, unknown>) => Promise<unknown>
  /** The desktop gallery as Rust reads it. */
  galleryItems: () => GalleryOut[]
  replyGallery: (requestId: string, items: GalleryOut[]) => Promise<unknown>
  addToGallery: (job: RemoteCreateJob, output: RemoteCreateOutput, index: number) => void
  /** Engine signals while a generation runs: a fraction of the current item
   *  and/or a short text. Returns the unsubscribe. */
  watchEngine?: (onSignal: (fraction: number | null, text: string | null) => void) => () => void
  now?: () => number
}

/** What the bar shows. Fed by Rust's `state` events only. */
interface RemoteCreateBarState {
  running: RemoteCreateRunning | null
  queued: number
}
export const useRemoteCreateStore = create<RemoteCreateBarState>()(() => ({ running: null, queued: 0 }))

const isVideoKind = (k: RemoteCreateKind) => k === 'video' || k === 'image-to-video'

/** What a kind makes, for the gallery and the cancel. */
export function mediaOf(kind: RemoteCreateKind): 'image' | 'video' | 'audio' {
  return isVideoKind(kind) ? 'video' : kind === 'music' ? 'audio' : 'image'
}

/** Does this kind run as a lane (lib/remote-create-lanes) on this engine? */
export function runsAsLane(kind: RemoteCreateKind, tool: RemoteCreateTool): boolean {
  if (kind === 'upscale' || kind === 'removebg' || kind === 'music') return true
  return tool === 'mlx' && (kind === 'edit' || kind === 'image-to-image')
}

/**
 * The file a media tool result names, or null for a failure or a result with
 * no file on disk. The URL is the last line that is one (a prompt may hold a
 * line break of its own).
 */
export function parseMediaResult(text: string): RemoteCreateOutput | null {
  if (!text || isMediaFailureResult(text)) return null
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).reverse()
  for (const line of lines) {
    const path = fileUrlToPath(line)
    if (path) return { path }
    if (/^https?:\/\//i.test(line)) {
      let url: URL
      try { url = new URL(line) } catch { continue }
      if (!url.pathname.endsWith('/view')) continue
      if ((url.searchParams.get('type') ?? 'output') !== 'output') continue
      const filename = url.searchParams.get('filename')
      if (!filename) continue
      return { comfyFilename: filename, comfySubfolder: url.searchParams.get('subfolder') ?? '' }
    }
  }
  return null
}

/** The first line of a failed result, for the phone. */
function reason(text: string): string {
  const first = (text || '').split('\n')[0].trim()
  return first.slice(0, 400) || 'The generation made no file.'
}

interface Current {
  id: string
  conversationId: string
  media: 'image' | 'video' | 'audio'
  cancelled: boolean
  abort: AbortController
}

export interface RemoteCreateRunner {
  handle: (event: RemoteCreateEvent) => Promise<void>
  currentJobId: () => string | null
}

export function createRemoteCreateRunner(deps: RemoteCreateDeps): RemoteCreateRunner {
  const now = deps.now ?? (() => Date.now())
  let current: Current | null = null
  let chain: Promise<void> = Promise.resolve()

  async function defaultModel(kind: RemoteCreateKind): Promise<string | null> {
    try {
      const caps = await deps.listModels()
      return caps.kinds[kind]?.models[0]?.id ?? null
    } catch {
      return null
    }
  }

  async function run(job: RemoteCreateJob): Promise<void> {
    const media = mediaOf(job.kind)
    const own: Current = { id: job.id, conversationId: job.conversation_id, media, cancelled: false, abort: new AbortController() }
    current = own
    const lane = runsAsLane(job.kind, deps.tool)
    const count = lane ? 1 : Math.max(1, job.count | 0)
    let index = 0
    let lastSent = 0
    // Engine signals arrive per sampler step: passed on at most twice a second.
    const report = (fraction: number | null, text: string | null) => {
      if (own.cancelled) return
      const t = now()
      if (t - lastSent < 500 && fraction !== null) return
      lastSent = t
      const p = fraction === null ? undefined : (index + Math.min(1, Math.max(0, fraction))) / count
      void deps.progress(job.id, { progress: p, stepText: text ?? undefined, index }).then((alive) => {
        if (!alive) own.cancelled = true
      }).catch(() => null)
    }
    let stopWatch: (() => void) | undefined
    const outputs: RemoteCreateOutput[] = []
    let error: string | null = null
    try {
      // The same gate as Create and the chat (lib/render/safety.ts), before
      // anything runs: a lane (edit, music, upscale, cut-out) reaches the
      // engines without image_generate, so it would pass unchecked otherwise.
      // The negative prompt is read apart (B30).
      const verdict = checkPromptSafety(`${job.prompt} ${job.lyrics ?? ''} ${job.character ?? ''}`, { negative: job.negative })
      if (verdict.blocked) throw new Error(blockMessageFor(verdict.reason))
      if (!(await deps.progress(job.id, { progress: 0, stepText: 'Starting', index: 0 }))) return
      stopWatch = deps.watchEngine?.(report)
      if (lane) {
        if (!(await deps.progress(job.id, { progress: 0, stepText: 'Generating', index: 0 }))) {
          own.cancelled = true
        } else {
          const text = await deps.runLane(job, { report, signal: own.abort.signal })
          if (!own.cancelled) {
            const out = parseMediaResult(text)
            if (out) {
              outputs.push(out)
              try { deps.addToGallery(job, out, 0) } catch (e) { log.warn('remote_create.gallery_failed', { err: e }) }
            } else {
              error = reason(text)
            }
          }
        }
      } else {
        // A run without a model would open the model picker on the desktop
        // and wait for a click there. The phone left it out: the first
        // installed. A character brings its own model.
        const model = job.model || (job.character ? null : await defaultModel(job.kind))
        const inputImage = deps.inputRef(job)
        for (index = 0; index < count; index++) {
          if (own.cancelled) break
          const label = count > 1 ? `${media === 'video' ? 'Clip' : 'Image'} ${index + 1} of ${count}` : 'Generating'
          if (!(await deps.progress(job.id, { progress: index / count, stepText: label, index }))) {
            own.cancelled = true
            break
          }
          const args: Record<string, unknown> = { prompt: job.prompt }
          if (job.negative) args.negativePrompt = job.negative
          if (model) args.model = model
          if (job.width) args.width = job.width
          if (job.height) args.height = job.height
          if (job.steps) args.steps = job.steps
          if (job.seed !== null && job.seed !== undefined) args.seed = job.seed + index
          if (inputImage) args.inputImage = inputImage
          if (job.character) args.character = job.character
          if (job.kind === 'edit') Object.assign(args, deps.editArgs?.(job) ?? {})
          const text = await deps.generate(media === 'video' ? 'video' : 'image', args, job.conversation_id)
          if (own.cancelled) break
          const out = parseMediaResult(text)
          if (out) {
            outputs.push(out)
            try { deps.addToGallery(job, out, index) } catch (e) { log.warn('remote_create.gallery_failed', { err: e }) }
          } else {
            error = reason(text)
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      stopWatch?.()
      if (current === own) current = null
    }
    // Rust has the job as cancelled already, nothing to report.
    if (own.cancelled) return
    try {
      await deps.finish(job.id, outputs.length > 0, error, outputs)
    } catch (e) {
      log.warn('remote_create.finish_failed', { err: e })
    }
  }

  async function capabilities(requestId: string): Promise<void> {
    let caps: RemoteCreateModels
    try {
      caps = await deps.listModels()
    } catch {
      caps = { kinds: {}, engine_ready: false }
    }
    await deps.replyCapabilities(requestId, { ...caps, desktop_busy: deps.desktopBusy() })
  }

  async function gallery(requestId: string): Promise<void> {
    let items: GalleryOut[] = []
    try { items = deps.galleryItems() } catch (e) { log.warn('remote_create.gallery_list_failed', { err: e }) }
    await deps.replyGallery(requestId, items)
  }

  return {
    currentJobId: () => current?.id ?? null,
    handle: async (event) => {
      switch (event.action) {
        case 'run':
          // Rust hands over one job at a time; the chain keeps it so here too.
          chain = chain.then(() => run(event.job)).catch(() => {})
          return chain
        case 'cancel':
          if (current && current.id === event.id && !current.cancelled) {
            current.cancelled = true
            current.abort.abort()
            deps.cancel(current.conversationId, current.media)
          }
          return
        case 'capabilities':
          return capabilities(event.request_id).catch((e) => log.warn('remote_create.capabilities_failed', { err: e }))
        case 'gallery':
          return gallery(event.request_id).catch((e) => log.warn('remote_create.gallery_failed', { err: e }))
        case 'state':
          useRemoteCreateStore.setState({ running: event.running, queued: event.queued })
          return
      }
    },
  }
}

// ── The real desktop ─────────────────────────────────────────────────────

const HANDOFF_TEXT: Record<string, string> = {
  deciding: 'Preparing',
  freeing_vram: 'Freeing memory for the model',
  loading_image_model: 'Loading the model',
  generating: 'Generating',
  restoring_text: 'Finishing',
}

async function realDeps(): Promise<RemoteCreateDeps> {
  const { isMlxImageHost } = await import('../api/mlx-image')
  const tool: RemoteCreateTool = isMlxImageHost() ? 'mlx' : 'comfyui'
  return {
    tool,
    generate: async (media, args, conversationId) => {
      const { generateMediaForRemote } = await import('../api/mcp/builtin-tools')
      return generateMediaForRemote(media, args, conversationId)
    },
    cancel: (conversationId, media) => {
      if (tool === 'comfyui') {
        // Ends exactly this conversation's prompt, by its id.
        void import('../api/vram-handoff').then(({ requestGenerationCancel }) => requestGenerationCancel(conversationId))
        return
      }
      // Music on a Mac ends through the run's own signal (runMacMusic).
      if (media === 'video') void import('../api/mlx-video').then(({ cancelVideo }) => cancelVideo()).catch(() => null)
      else if (media === 'image') void import('../api/mlx-image').then(({ cancelMlxGenerate }) => cancelMlxGenerate()).catch(() => null)
    },
    runLane: async (job, watch) => {
      const lanes = await import('./remote-create-lanes')
      return tool === 'mlx' ? lanes.runLaneOnMac(job, watch) : lanes.runLaneOnComfy(job)
    },
    editArgs: (job) => {
      const names = (job.inputs ?? []).slice(1).map((i) => i.input_comfy_name).filter((n): n is string => !!n)
      const mask = job.mask?.input_comfy_name
      // The strength the Edit slider has, at most what Edit repaints.
      const denoise = Math.min(createStoreRef?.getState().denoise ?? 0.75, 0.95)
      return { denoise, ...(names.length ? { referenceImages: names } : {}), ...(mask ? { maskImage: mask } : {}) }
    },
    listModels: async () => {
      const lanes = await import('./remote-create-lanes')
      return tool === 'mlx' ? lanes.macCapabilities() : lanes.comfyCapabilities()
    },
    galleryItems: () => {
      const items = galleryStoreRef?.getState().gallery ?? []
      return galleryForRemoteRef ? galleryForRemoteRef(items) : []
    },
    replyGallery: (requestId, items) => backendCall('remote_create_gallery_reply', { requestId, items }),
    desktopBusy: () => {
      const s = createStoreRef?.getState()
      return !!s?.isGenerating
    },
    inputRef: (job) => {
      if (job.input_path) return job.input_path
      if (job.input_comfy_name && getImageUrlRef) return getImageUrlRef(job.input_comfy_name, '', 'input')
      return undefined
    },
    progress: (id, p) => backendCall<boolean>('remote_create_progress', { id, progress: p.progress, stepText: p.stepText, index: p.index }),
    finish: (id, ok, error, outputs) => backendCall('remote_create_finish', { id, ok, error, outputs }),
    replyCapabilities: (requestId, capabilities) => backendCall('remote_create_capabilities_reply', { requestId, capabilities }),
    addToGallery: (job, out, index) => {
      const add = createStoreRef?.getState().addToGallery
      if (!add) return
      const name = out.path ? out.path.split(/[\\/]/).pop() || `remote-${Date.now()}` : out.comfyFilename ?? `remote-${Date.now()}`
      add({
        id: `${job.id}-${index}`,
        type: mediaOf(job.kind),
        filename: name,
        subfolder: out.comfySubfolder ?? '',
        ...(out.comfyFilename ? { comfyType: 'output' } : {}),
        ...(out.path ? { localPath: out.path } : {}),
        prompt: job.prompt,
        negativePrompt: job.negative,
        model: job.model ?? '',
        modelType: 'unknown',
        seed: job.seed !== null ? job.seed + index : 0,
        steps: job.steps ?? 0,
        cfgScale: 0,
        sampler: '',
        scheduler: '',
        width: job.width ?? 0,
        height: job.height ?? 0,
        batchSize: 1,
        createdAt: Date.now(),
        label: FROM_YOUR_PHONE,
      })
    },
    watchEngine: (onSignal) => {
      const offs: (() => void)[] = []
      void import('../api/vram-handoff').then(({ onHandoff }) => {
        offs.push(onHandoff((d) => {
          const text = HANDOFF_TEXT[d.phase]
          if (text) onSignal(null, text)
        }))
      })
      if (tool === 'comfyui') {
        void import('../api/comfyui-ws').then(({ comfyWS }) => {
          offs.push(comfyWS.on((ev) => {
            if (ev.type === 'progress' && ev.data.max > 0) onSignal(ev.data.value / ev.data.max, `Step ${ev.data.value} of ${ev.data.max}`)
          }))
        })
      }
      return () => { for (const off of offs.splice(0)) off() }
    },
  }
}

// Read once at start so the store and the URL helper are not imported per call.
let createStoreRef: { getState: () => { isGenerating: boolean; denoise: number; addToGallery: (item: import('../stores/createStore').GalleryItem) => void } } | null = null
let galleryStoreRef: { getState: () => { gallery: import('../stores/createStore').GalleryItem[] } } | null = null
let galleryForRemoteRef: typeof import('./remote-create-lanes').galleryForRemote | null = null
let getImageUrlRef: ((filename: string, subfolder?: string, type?: string) => string) | null = null

let started: Promise<() => void> | null = null

/** Listen for jobs from Rust for the life of the window. Once. */
export function startRemoteCreateRunner(): Promise<() => void> {
  if (!isTauri()) return Promise.resolve(() => {})
  if (started) return started
  started = (async () => {
    const [{ listen }, store, comfy, lanes, deps] = await Promise.all([
      import('@tauri-apps/api/event'), import('../stores/createStore'), import('../api/comfyui'), import('./remote-create-lanes'), realDeps(),
    ])
    createStoreRef = store.useCreateStore
    galleryStoreRef = store.useCreateStore
    galleryForRemoteRef = lanes.galleryForRemote
    getImageUrlRef = comfy.getImageUrl
    const runner = createRemoteCreateRunner(deps)
    const off = await listen<RemoteCreateEvent>(REMOTE_CREATE_EVENT, (e) => { void runner.handle(e.payload) })
    // Rust names the Create words of a phone's status from the last answer
    // (CREATE-V2.md): it gets one at start, without a question.
    void runner.handle({ action: 'capabilities', request_id: '' })
    // A window that loads while a job runs still shows the bar.
    try {
      const snap = await backendCall<RemoteCreateEvent>('remote_create_snapshot')
      if (snap && snap.action === 'state') await runner.handle(snap)
    } catch { /* an older backend */ }
    return off
  })()
  return started
}

/** Cancel from the desktop bar. */
export function cancelRemoteCreateJob(id: string): Promise<unknown> {
  return backendCall('remote_create_cancel', { id })
}
