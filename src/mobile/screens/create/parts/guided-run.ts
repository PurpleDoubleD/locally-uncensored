/**
 * The run of a guided preset: its state and everything a button of the page
 * does. Lives in the module, not in the page, because a step renders in the
 * cloud for minutes while the page may be gone (another tab, the gallery).
 *
 * One preset is open at a time. Its steps are booked one by one, each with
 * its own confirmed price. A booked job is written into the ledger of the
 * phone (lib/pending-cloud-jobs.ts) before the first poll, and its request id
 * before the submit leaves, exactly as the cloud hook of Create does it: a
 * phone that kills the app in the middle still gets the result into the
 * gallery, and nothing is ever sent twice.
 *
 * While a step runs, the create store says `isGenerating`, the one gate for
 * "a cloud run is in flight" in the whole app. The main page of Create shows
 * the run on its stage through that, and its Cancel is routed here
 * (isGuidedRunning, cancelGuided).
 */
import { create } from 'zustand'
import { CloudJobError } from '../../../../api/cloud/client'
import { cancelJob, pollJob, QuoteChangedError, submitCloudJob, uploadInput, type CloudJob } from '../../../../api/cloud/jobs'
import { studioQuote, StudioQuoteChangedError } from '../../../../api/cloud/studio'
import { RENDER_CANNOT_STOP, SIGN_IN_TO_RENDER, throttleMessage } from '../../../../hooks/useCloudCreate'
import { dataUrlToBlob } from '../../../../lib/render/data-url'
import { forgetPendingCloudJob, noteCloudSubmitIntent, notePendingCloudJob, settleCloudSubmitIntent, unwatchCloudJob } from '../../../../lib/pending-cloud-jobs'
import { platformText } from '../../../../lib/platform-text'
import { galleryItemFromJob } from '../../../../lib/render/cloud-jobs'
import { studioOptions } from '../../../../lib/render/studio-contract'
import { useCloudAuthStore } from '../../../../stores/cloudAuthStore'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { errorText } from '../../../../types/json-guards'
import { fetchItemBlob, ResultGoneError } from './adapters/result-url'
import { checkFile } from './files'
import {
  keptPaths, priceKeyOf, runLabel, slotFor, stepEstimate, stepMissing, stepParams, stepView, uploadRoleOf,
  type CreatePreset, type InputKind, type StepDraft, type StepPaths, type StepView,
} from './guided'
import { ImageLoadError, loadPhoneImage } from './photos'

/** What stands in an input slot, for the eye: a name and, for pictures and clips, something to show. */
export interface Attached {
  name: string
  kind: InputKind
  /** An object URL of the file. Revoked when the slot is emptied. */
  url?: string
  /** How many files (reference images). */
  count: number
  /** It is the result of the step before. */
  carried?: boolean
}

export interface StepDone {
  jobId: string
  kind: 'image' | 'video' | 'audio' | '3d'
}

export type FileTrouble =
  | { kind: 'too-large'; sizeMb: number; limitMb: number }
  | { kind: 'wrong-kind'; wanted: InputKind }
  | { kind: 'empty' }
  | { kind: 'heic' }
  | { kind: 'too-heavy' }
  | { kind: 'undecodable' }
  | { kind: 'upload'; message: string }
  | { kind: 'gone' }

export interface GuidedState {
  preset: CreatePreset | null
  index: number
  prompt: string
  options: Record<string, unknown>
  paths: StepPaths
  attached: Record<string, Attached>
  /** The model the user picked per step. */
  picked: Record<number, string>
  done: Record<number, StepDone>
  /** A file is on its way up for this slot. */
  uploading: string | null
  /** What was wrong with the last file, by slot. */
  trouble: { key: string; problem: FileTrouble } | null
  /** Why the price or the run failed, as the cloud layer says it. */
  error: string | null
  /** The price the server confirmed, and for which input. */
  quote: number | null
  quotedKey: string
  quoting: boolean
  /** The last price check was held back by the rate limit: the last confirmed price stands in. */
  rateLimited: boolean
  /** Seconds of the input the server measured, for the estimate of the next change. */
  measured: { key: string; seconds: number } | null
  submitting: boolean
  activeJob: string | null
  startedAt: number | null
  cancelling: boolean
  /** Bumped to ask for a price again although nothing changed (after "Try again"). */
  round: number
}

const EMPTY_STEP = { prompt: '', options: {}, paths: {}, attached: {}, uploading: null, trouble: null, error: null, quote: null, quotedKey: '', quoting: false, rateLimited: false, measured: null } as const

function fresh(): GuidedState {
  return { preset: null, index: 0, ...EMPTY_STEP, options: {}, paths: {}, attached: {}, picked: {}, done: {}, submitting: false, activeJob: null, startedAt: null, cancelling: false, round: 0 }
}

export const useGuided = create<GuidedState>()(() => fresh())

const get = () => useGuided.getState()
const set = (patch: Partial<GuidedState>) => useGuided.setState(patch)

// ---------- read ----------

export function viewOf(s: GuidedState): StepView | null {
  return s.preset ? stepView(s.preset, s.index, s.picked[s.index]) : null
}

export function draftOf(s: GuidedState): StepDraft {
  return { prompt: s.prompt, options: s.options, paths: s.paths }
}

/** A step is being booked or rendered. */
export function runBusy(s: GuidedState): boolean {
  return s.submitting || s.activeJob !== null
}

/** The confirmed price belongs to what is on the page right now. */
export function priceUsable(s: GuidedState): boolean {
  const view = viewOf(s)
  if (!view || s.quote === null) return false
  const draft = draftOf(s)
  if (stepMissing(view, draft)) return false
  return s.quotedKey === priceKeyOf(view, draft) || s.rateLimited
}

export function estimateOf(s: GuidedState): number | null {
  const view = viewOf(s)
  if (!view) return null
  const draft = draftOf(s)
  const key = JSON.stringify([s.paths, s.options.order ?? 'meanwhile'])
  return stepEstimate(view, draft, s.measured?.key === key ? s.measured.seconds : undefined)
}

function measureKey(s: GuidedState): string {
  return JSON.stringify([s.paths, s.options.order ?? 'meanwhile'])
}

/** True while a step of a guided preset is being booked or rendered. */
export function isGuidedRunning(): boolean {
  return runBusy(get())
}

// ---------- open, close, move ----------

function releaseAttached(attached: Record<string, Attached>, keep?: (key: string) => boolean): Record<string, Attached> {
  const next: Record<string, Attached> = {}
  for (const [key, value] of Object.entries(attached)) {
    if (keep?.(key)) next[key] = value
    else if (value.url) URL.revokeObjectURL(value.url)
  }
  return next
}

/** Open a preset. The one that is already open stays as it is, so a run goes on where the user left the page. */
export function openGuided(preset: CreatePreset): void {
  const s = get()
  if (s.preset?.id === preset.id) return
  if (runBusy(s)) return
  releaseAttached(s.attached)
  useGuided.setState({ ...fresh(), preset }, true)
}

/** Back to an empty first step. What was made stays in the gallery. */
export function startOverGuided(): void {
  const s = get()
  if (!s.preset || runBusy(s)) return
  releaseAttached(s.attached)
  useGuided.setState({ ...fresh(), preset: s.preset, round: s.round + 1 }, true)
}

/** True when leaving the preset would lose something the user put in. */
export function guidedTouched(s: GuidedState): boolean {
  return s.index > 0 || Object.keys(s.done).length > 0 || s.prompt.trim().length > 0 || Object.keys(s.paths).length > 0
}

export function setGuidedPrompt(prompt: string): void {
  set({ prompt })
}

export function setGuidedOption(key: string, value: unknown): void {
  const options = { ...get().options }
  if (value === undefined || value === '') delete options[key]
  else options[key] = value
  set({ options })
}

/** Run this step on another model. Only uploads the new model reads survive. */
export function chooseGuidedModel(id: string): void {
  const s = get()
  const view = viewOf(s)
  if (!s.preset || !view || id === view.model || runBusy(s)) return
  const paths = keptPaths(s.preset, s.index, id, s.paths)
  set({
    picked: { ...s.picked, [s.index]: id },
    options: {},
    paths,
    attached: releaseAttached(s.attached, (key) => key in paths),
    quote: null,
    quotedKey: '',
    rateLimited: false,
    error: null,
    trouble: null,
  })
}

// ---------- inputs ----------

function troubleOf(err: unknown): FileTrouble {
  if (err instanceof ImageLoadError) {
    const p = err.problem
    if (p.kind === 'too-large') return { kind: 'too-large', sizeMb: p.sizeMb, limitMb: p.limitMb }
    if (p.kind === 'wrong-kind') return { kind: 'wrong-kind', wanted: p.wanted }
    if (p.kind === 'empty') return { kind: 'empty' }
    return p.heic ? { kind: 'heic' } : p.heavy ? { kind: 'too-heavy' } : { kind: 'undecodable' }
  }
  if (err instanceof ResultGoneError) return { kind: 'gone' }
  return { kind: 'upload', message: errorText(err) }
}

/** A picture is decoded, turned and scaled like every photo of Create; a clip or a sound goes up as it is. */
async function prepare(file: File, kind: InputKind): Promise<Blob> {
  if (kind === 'image') return dataUrlToBlob((await loadPhoneImage(file)).url)
  const bad = checkFile(file, kind)
  if (bad) throw new ImageLoadError(bad.kind === 'too-large' ? { kind: 'too-large', sizeMb: bad.sizeMb, limitMb: bad.limitMb } : bad.kind === 'empty' ? { kind: 'empty' } : { kind: 'wrong-kind', wanted: kind })
  return file
}

/** Is the step still the one the upload was started for. */
function sameStep(preset: CreatePreset, index: number, model: string): boolean {
  const s = get()
  return s.preset?.id === preset.id && s.index === index && viewOf(s)?.model === model
}

async function putIntoSlot(key: string, files: readonly { blob: () => Promise<Blob>; name: string }[], carried: boolean): Promise<boolean> {
  const s = get()
  const view = viewOf(s)
  const input = view?.inputs.find((i) => i.key === key)
  if (!s.preset || !view || !input || s.uploading || runBusy(s) || files.length === 0) return false
  const { preset, index } = s
  const model = view.model
  set({ uploading: key, trouble: null, error: null })
  try {
    const taken = input.many ? files : files.slice(0, 1)
    const uploaded: string[] = []
    let first: Blob | null = null
    for (const file of taken) {
      const blob = await file.blob()
      if (!first) first = blob
      uploaded.push(await uploadInput(blob, uploadRoleOf(key)))
    }
    // The user moved on while the file went up: it belongs to a step that is gone.
    if (!sameStep(preset, index, model)) return false
    const now = get()
    const before = now.attached[key]
    if (before?.url) URL.revokeObjectURL(before.url)
    const url = first && input.kind !== 'audio' ? URL.createObjectURL(first) : undefined
    set({
      paths: { ...now.paths, [key]: input.many ? uploaded : uploaded[0] },
      attached: { ...now.attached, [key]: { name: taken[0].name, kind: input.kind, url, count: uploaded.length, carried } },
    })
    return true
  } catch (err) {
    if (sameStep(preset, index, model)) set({ trouble: { key, problem: troubleOf(err) } })
    return false
  } finally {
    if (get().uploading === key) set({ uploading: null })
  }
}

/** Files from the phone go into the slot `key`. */
export function attachGuidedFiles(key: string, files: readonly File[]): Promise<boolean> {
  const kind = viewOf(get())?.inputs.find((i) => i.key === key)?.kind ?? 'image'
  return putIntoSlot(key, files.map((file) => ({ name: file.name, blob: () => prepare(file, kind) })), false)
}

/** A result of the gallery goes into the slot `key`. Its bytes are fetched and uploaded again, as the desktop does. */
export function attachGuidedItem(key: string, item: GalleryItem, carried = false): Promise<boolean> {
  const name = item.label || item.prompt || item.id
  return putIntoSlot(key, [{ name, blob: () => fetchItemBlob(item) }], carried)
}

export function removeGuidedInput(key: string): void {
  const s = get()
  if (runBusy(s) || s.uploading === key) return
  const paths = { ...s.paths }
  delete paths[key]
  set({ paths, attached: releaseAttached(s.attached, (k) => k !== key), trouble: s.trouble?.key === key ? null : s.trouble })
}

/** The clip a classic extend model continues: a result of the gallery, by its address. */
export function setGuidedClip(item: GalleryItem | null): void {
  const s = get()
  if (runBusy(s)) return
  const paths = { ...s.paths }
  const attached = { ...s.attached }
  if (item?.remoteUrl) {
    paths.source_url = item.remoteUrl
    attached.source_url = { name: item.label || item.prompt || item.id, kind: 'video', count: 1 }
  } else {
    delete paths.source_url
    delete attached.source_url
  }
  set({ paths, attached })
}

// ---------- the price ----------

let quoteToken = 0

/**
 * Ask for the price of what is on the page. The latest call wins; an answer
 * for an older input is dropped. A step that still misses something has no
 * price and asks nobody.
 */
export async function refreshGuidedQuote(): Promise<void> {
  const token = ++quoteToken
  const s = get()
  const view = viewOf(s)
  if (!view || s.done[s.index] || runBusy(s)) return
  const draft = draftOf(s)
  if (stepMissing(view, draft)) {
    set({ quote: null, quotedKey: '', quoting: false, rateLimited: false })
    return
  }
  const key = priceKeyOf(view, draft)
  const mKey = measureKey(s)
  set({ quoting: true })
  const stillAsked = () => token === quoteToken
  try {
    let cost: number
    let seconds: number | undefined
    if (view.studio) {
      // The same check the server runs: a wrong value says so here, before a request.
      studioOptions(view.model, draft.prompt, draft.options)
      const data = await studioQuote(view.model, draft.prompt, { op: 'studio', studio_options: draft.options, ...draft.paths })
      if (!Number.isSafeInteger(data.credits) || data.credits < 1) throw new Error('Invalid price response')
      cost = data.credits
      seconds = Number.isFinite(data.seconds) ? (data.seconds as number) : undefined
    } else {
      const classic = stepEstimate(view, draft)
      // No price in the catalog: rather none than an invented one. The start stays locked.
      if (classic === null) throw new Error('There is no price for this model right now.')
      cost = classic
    }
    if (!stillAsked()) return
    set({ quote: cost, quotedKey: key, error: null, rateLimited: false, ...(seconds !== undefined ? { measured: { key: mKey, seconds } } : {}) })
  } catch (err) {
    if (!stillAsked()) return
    if (err instanceof StudioQuoteChangedError) {
      // The provider's price moved: show the new number, the user starts again with it in view.
      set({ quote: err.credits, quotedKey: key, rateLimited: false, error: `The price changed to ${err.credits.toLocaleString('en-US')} credits. Review it and start again.`, ...(Number.isFinite(err.seconds) ? { measured: { key: mKey, seconds: err.seconds as number } } : {}) })
    } else if (err instanceof CloudJobError && err.status === 429) {
      // The rate limit of the price check, not a wrong price: the last confirmed number stands in.
      set({ rateLimited: get().quote !== null, error: null })
    } else {
      set({ quote: null, quotedKey: '', rateLimited: false, error: errorText(err) })
    }
  } finally {
    if (stillAsked()) set({ quoting: false })
  }
}

// ---------- run ----------

let abort: AbortController | null = null

function deadlineMs(kind: string): number {
  return kind === 'video' ? 45 * 60_000 : 15 * 60_000
}

async function refreshQuota(): Promise<void> {
  try {
    const { getQuota } = await import('../../../../api/cloud/jobs')
    useCloudAuthStore.getState().setQuota(await getQuota())
  } catch {
    /* the number on screen stays until the next answer */
  }
}

export type StartRefusal = 'busy' | 'no-price' | 'credits'

/**
 * Book the step and wait for its result. Resolves when the run ended, however
 * it ended; what happened is in the state. Returns the reason when nothing
 * was started.
 */
export async function runGuidedStep(): Promise<StartRefusal | null> {
  const s = get()
  const view = viewOf(s)
  const create = useCreateStore.getState()
  if (!s.preset || !view || runBusy(s) || s.uploading || create.isGenerating) return 'busy'
  if (!priceUsable(s) || s.quote === null) return 'no-price'
  const quota = useCloudAuthStore.getState().quota
  if (quota && quota.remaining.credits < s.quote) return 'credits'

  const { preset, index } = s
  const draft = draftOf(s)
  const quote = s.quote
  const key = priceKeyOf(view, draft)
  const label = runLabel(preset, index)
  const requestId = crypto.randomUUID()
  const timeoutMs = deadlineMs(view.kind)
  const startedAt = Date.now()
  const item = { prompt: draft.prompt, label }
  const ac = new AbortController()
  abort = ac

  set({ submitting: true, error: null, trouble: null, startedAt, cancelling: false })
  create.setError(null)
  create.setIsGenerating(true)
  create.setProgress(0, `Generating ${label}`)
  create.setProgressPhase('queued')

  let jobId: string | null = null
  try {
    // Written down before the request leaves, so a kill between the tap and the answer loses nothing.
    noteCloudSubmitIntent({ requestId, count: 1, kind: view.kind, op: view.op, model: view.model, prompt: draft.prompt, sentAt: startedAt, timeoutMs, landing: 'gallery', items: [item] })
    let submitted: Awaited<ReturnType<typeof submitCloudJob>>
    try {
      submitted = await submitCloudJob({ kind: view.kind, model: view.model, prompt: draft.prompt, params: { ...stepParams(view, draft), label, max_credits: quote, client_request_id: requestId } })
    } catch (err) {
      const status = err instanceof CloudJobError ? err.status : 0
      // A clear "no" booked nothing. Anything else leaves the question open for the next resume pass.
      settleCloudSubmitIntent(requestId, status >= 400 && status < 500 && status !== 408)
      throw err
    }
    jobId = submitted.id
    notePendingCloudJob({ id: jobId, kind: view.kind, op: view.op, model: view.model, prompt: draft.prompt, startedAt, deadlineAt: startedAt + timeoutMs, landing: 'gallery', item })
    settleCloudSubmitIntent(requestId, true)
    set({ submitting: false, activeJob: jobId })

    let job: CloudJob
    try {
      job = await pollJob(jobId, {
        timeoutMs,
        signal: ac.signal,
        onTick: (j) => {
          if (j.status === 'running') useCreateStore.getState().setProgressPhase('sampling')
        },
      })
      forgetPendingCloudJob(jobId)
    } catch (err) {
      const status = err instanceof CloudJobError ? err.status : 0
      const definitive = status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
      // Not definitive: the job stays in the ledger and the resume pass of the shell lands it later.
      if (definitive) forgetPendingCloudJob(jobId)
      else unwatchCloudJob(jobId)
      throw err
    }

    if (job.status === 'succeeded' && job.result_url) {
      const st = useCreateStore.getState()
      st.setProgressPhase('complete')
      // mergeGallery, not addToGallery: the result must not move the model picker of the main page.
      st.mergeGallery([{ ...galleryItemFromJob(job), prompt: draft.prompt, label } as GalleryItem])
      const now = get()
      if (now.preset?.id === preset.id) set({ done: { ...now.done, [index]: { jobId: job.id, kind: job.kind } }, quote: null, quotedKey: '', rateLimited: false })
    } else if (job.status !== 'canceled') {
      throw new Error(job.error ?? 'Cloud render failed.')
    }
  } catch (err) {
    let message: string | null
    if (err instanceof QuoteChangedError) {
      // The server found a higher price while booking: show it, never book against it silently.
      set({ quote: err.credits, quotedKey: key, rateLimited: false })
      message = `The price changed to ${err.credits.toLocaleString('en-US')} credits. Review it and start again.`
    } else if (err instanceof CloudJobError && err.status === 401) message = SIGN_IN_TO_RENDER
    // A 429 is read by its code, as in the main run: a limit says the server's sentence, an empty wallet its own.
    else if (err instanceof CloudJobError && err.status === 429) message = throttleMessage(err)
    else if (err instanceof CloudJobError && err.message === 'render timed out') message = platformText('renderStillRunning')
    else if (err instanceof CloudJobError && err.message === 'polling aborted') message = null
    else message = errorText(err)
    if (message && get().preset?.id === preset.id) set({ error: message })
    // The stage of the main page says it too, for a user who left this page.
    if (message && !(err instanceof QuoteChangedError)) useCreateStore.getState().setError(message)
  } finally {
    if (abort === ac) abort = null
    set({ submitting: false, activeJob: null, startedAt: null, cancelling: false })
    const st = useCreateStore.getState()
    st.setIsGenerating(false)
    st.setProgress(0)
    void refreshQuota()
  }
  return null
}

/** Cancel the running step. A job a GPU already took cannot be stopped: it finishes, is charged and lands in the gallery. */
export async function cancelGuided(): Promise<void> {
  const s = get()
  if (s.cancelling) return
  if (!s.activeJob) {
    // Still booking: nothing to cancel at the server yet, the wait is given up.
    abort?.abort()
    return
  }
  set({ cancelling: true })
  try {
    await cancelJob(s.activeJob)
    abort?.abort()
    void refreshQuota()
  } catch (err) {
    if (err instanceof CloudJobError && err.status === 409) {
      set({ error: RENDER_CANNOT_STOP, cancelling: false })
      useCreateStore.getState().setError(RENDER_CANNOT_STOP)
    } else {
      set({ error: errorText(err), cancelling: false })
    }
  }
}

// ---------- after a step ----------

function galleryItemOf(done: StepDone | undefined): GalleryItem | null {
  if (!done) return null
  return useCreateStore.getState().gallery.find((g) => g.jobId === done.jobId || g.id === done.jobId) ?? null
}

/** The result of step `index`, as the gallery holds it. */
export function guidedResult(s: GuidedState, index: number): GalleryItem | null {
  return galleryItemOf(s.done[index])
}

/**
 * On to the next step. Its input is the result of this one: it is put into
 * the fitting slot by itself, so nobody has to save a file and pick it again.
 */
export async function nextGuidedStep(): Promise<void> {
  const s = get()
  if (!s.preset || runBusy(s) || s.index >= s.preset.steps.length - 1 || !s.done[s.index]) return
  const from = s.done[s.index]
  releaseAttached(s.attached)
  set({ index: s.index + 1, ...EMPTY_STEP, options: {}, paths: {}, attached: {} })
  const next = viewOf(get())
  const item = galleryItemOf(from)
  if (!next || !item) return
  if (next.needsGalleryClip && from.kind === 'video') {
    setGuidedClip(item)
    return
  }
  const slot = slotFor(next, from.kind)
  if (slot) await attachGuidedItem(slot.key, item, true)
}

/** Drop the result of this step from the run and stand where it was made, words and uploads still there. */
export function redoGuidedStep(): void {
  const s = get()
  if (runBusy(s) || !s.done[s.index]) return
  const done = { ...s.done }
  delete done[s.index]
  set({ done, error: null, quote: null, quotedKey: '', rateLimited: false, round: s.round + 1 })
}

/** Test seam. */
export function __resetGuidedForTests(): void {
  quoteToken = 0
  abort = null
  useGuided.setState(fresh(), true)
}
