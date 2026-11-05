/**
 * B26 (3.0.9): the first wait of a local chat turn, when it does not end.
 *
 * Discord, 28.10.2026: a 27B model at IQ2_M on an 8 GB card sat on "Reading
 * the conversation" with nothing else said, until the user gave up. Ollama
 * had put most of the model on the CPU, and reading the conversation there
 * takes minutes. LU knew nothing of it, because it never asked.
 *
 * Now it asks, once the wait is long enough to need words: /api/ps says
 * whether the model is loaded yet and how much of it sits in graphics memory
 * (`size` and `size_vram`, the same figures lib/ollama-window-fit reads).
 * Only what Ollama reports is said, nothing is predicted. While the model is
 * not listed, it is still loading. When part of it runs on the CPU, the line
 * says how much and names a smaller installed model that would fit, or the
 * size one would need.
 *
 * The words are pure, so every sentence is a test; the watch is small.
 */

import { listModels, readLoadedModels, type LoadedOllamaModel } from '../api/ollama'
import { getProviderIdFromModel } from '../api/providers/model-name'
import { cpuSharePercent } from './ollama-window-fit'
import { useRunActivityStore, type RunActivity } from '../stores/runActivityStore'

/** How long a first wait runs before LU looks why. A turn that answers sooner needs no sentence. */
export const FIRST_WAIT_LOOK_AFTER_MS = 10_000
/** How often it looks again while the wait goes on. */
export const FIRST_WAIT_LOOK_EVERY_MS = 5_000

/** Room the context and the runtime need next to the weights, so a model
 *  that would only just fit is not offered as one that fits. */
const FIT_HEADROOM = 0.85

/** An installed model and its file size, as Ollama lists it. */
export interface InstalledSize {
  name: string
  size: number
}

function gigabytes(bytes: number): string {
  const gb = bytes / 1_073_741_824
  return gb >= 10 ? `${Math.round(gb)} GB` : `${Math.round(gb * 10) / 10} GB`
}

/** Ollama lists "name" and "name:latest" for the same model. */
function sameModel(a: string, b: string): boolean {
  const bare = (n: string) => (n.endsWith(':latest') ? n.slice(0, -7) : n)
  return bare(a) === bare(b)
}

/**
 * The largest installed model whose file fits in what the card holds, or
 * null. `cardBytes` is what Ollama could put in graphics memory for the model
 * that did not fit: a measured figure, not a spec sheet.
 */
export function smallerModelThatFits(installed: readonly InstalledSize[], current: string, cardBytes: number): InstalledSize | null {
  const room = cardBytes * FIT_HEADROOM
  const fits = installed
    .filter((m) => m.size > 0 && m.size <= room && !sameModel(m.name, current))
    .sort((a, b) => b.size - a.size)
  return fits[0] ?? null
}

/**
 * What the status line says after the first look. Null when there is nothing
 * to add: the model is loaded and all of it is on the card, or Ollama did not
 * answer (then nothing is known, and nothing is said).
 */
export function firstWaitActivity(input: {
  /** The reading line that stood until now. */
  reading: RunActivity
  model: string
  /** /api/ps, or null when it could not be read. */
  loaded: readonly LoadedOllamaModel[] | null
  installed: readonly InstalledSize[]
}): RunActivity | null {
  const { reading, model, loaded, installed } = input
  if (!loaded) return null
  const entry = loaded.find((m) => sameModel(m.name, model))
  if (!entry) {
    // Listed from the moment its runner starts, so not listed means the load
    // has not got that far, or the model waits behind another one.
    return { label: 'Loading the model', kind: 'reading', detail: model }
  }
  const share = cpuSharePercent(entry)
  if (share === null || share <= 0) return null
  const onCard = Math.min(entry.sizeVram, entry.size)
  const where = share >= 100
    ? `${model} runs entirely on the CPU (${gigabytes(entry.size)}), so reading the conversation can take minutes.`
    : `Only ${gigabytes(onCard)} of ${model}'s ${gigabytes(entry.size)} fit on your graphics card. The other ${share}% runs on the CPU, so reading the conversation can take minutes.`
  const smaller = onCard > 0 ? smallerModelThatFits(installed, model, onCard) : null
  const advice = smaller
    ? `A model that fits answers much faster, for example ${smaller.name} (${gigabytes(smaller.size)}).`
    : onCard > 0
      ? `A model under ${gigabytes(onCard * FIT_HEADROOM)} fits on your card and answers much faster.`
      : 'A smaller model, or one with a lower quantization, answers much faster.'
  return { ...reading, hint: `${where} ${advice}` }
}

/**
 * Watch the first wait of a local Ollama turn and say why it lasts. Stops by
 * itself once the line is no longer a reading line (the first word arrived,
 * see endFirstWait) or on `signal`. Never throws.
 */
export function watchFirstWait(opts: {
  conversationId: string
  model: string
  signal?: AbortSignal
  readLoaded: () => Promise<LoadedOllamaModel[]>
  readInstalled: () => Promise<InstalledSize[]>
  getActivity: () => RunActivity | undefined
  setActivity: (activity: RunActivity) => void
  firstLookMs?: number
  everyMs?: number
}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // The run's own line without anything this watch added, so a later look
  // can go back to it (a load that finished turns "Loading the model" back
  // into reading, a hidden thought turns reading into "Thinking").
  let reading: RunActivity | null = null
  let installed: InstalledSize[] | null = null
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', stop)
  }
  opts.signal?.addEventListener('abort', stop, { once: true })
  // The first wait, and the hidden thinking after it: a model partly on the
  // CPU writes its hidden thoughts just as slowly (Mac run 30.10.: "Thinking"
  // for seven minutes on 5.6 of 18.1 GB on the card). Any other line, or
  // none, ends the watch: the model answers, or the turn is over.
  const waiting = (a: RunActivity | undefined) => a?.kind === 'reading' || a?.kind === 'thinking'
  const own = (a: RunActivity): RunActivity => ({ label: a.label, kind: a.kind, ...(a.detail ? { detail: a.detail } : {}) })
  const look = async () => {
    timer = null
    if (stopped) return
    const now = opts.getActivity()
    if (!now || !waiting(now)) { stop(); return }
    if (now.label !== 'Loading the model') reading = own(now)
    let loaded: LoadedOllamaModel[] | null = null
    try { loaded = await opts.readLoaded() } catch { loaded = null }
    if (stopped) return
    // The first word may have come in while /api/ps was being read.
    const after = opts.getActivity()
    if (!after || !waiting(after)) { stop(); return }
    if (after.label !== 'Loading the model') reading = own(after)
    const base = reading ?? { label: 'Reading the conversation', kind: 'reading' as const }
    // Read once, and only when it is needed: when part of the model is on the CPU.
    if (!installed && loaded?.some((m) => sameModel(m.name, opts.model) && m.sizeVram < m.size)) {
      installed = await opts.readInstalled().catch(() => [])
      if (stopped) return
    }
    const next = firstWaitActivity({ reading: base, model: opts.model, loaded, installed: installed ?? [] })
    if (next) opts.setActivity(next)
    else if (loaded) opts.setActivity(base)
    timer = setTimeout(() => void look(), opts.everyMs ?? FIRST_WAIT_LOOK_EVERY_MS)
  }
  if (!opts.signal?.aborted) timer = setTimeout(() => void look(), opts.firstLookMs ?? FIRST_WAIT_LOOK_AFTER_MS)
  else stopped = true
  return stop
}

/**
 * The watch for a chat or agent turn on `model`: only Ollama reports what it
 * loaded, so other backends get nothing. Returns the stop handle; the run
 * calls it when the turn ends, and it ends by itself at the first word.
 */
export function watchChatFirstWait(conversationId: string | null | undefined, model: string | null | undefined, signal?: AbortSignal): () => void {
  if (!conversationId || !model || getProviderIdFromModel(model) !== 'ollama') return () => {}
  return watchFirstWait({
    conversationId,
    model,
    signal,
    readLoaded: () => readLoadedModels(signal),
    // Ollama's own list: the model store carries no file sizes (size 0 for
    // every entry, Mac run 30.10.), /api/tags does.
    readInstalled: async () => (await listModels()).map((m) => ({ name: m.name, size: m.size })),
    getActivity: () => useRunActivityStore.getState().activity[conversationId],
    setActivity: (activity) => useRunActivityStore.getState().setActivity(conversationId, activity),
  })
}
