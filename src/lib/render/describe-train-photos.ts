// 3.0.8 D28: "Describe photos" in the Train tab. The user's own local chat
// model, if it can see images, writes the per photo description (clothes,
// hair, place) the user would otherwise type. Local only on purpose: the
// photos are of a real person more often than not, and the Train tab runs on
// this machine, so they never go to a cloud model from here. Same provider
// call a chat turn makes, queued in the local lane behind a running chat
// turn (run-slot), never throws: a photo that fails keeps an empty field.

import { getProviderForModel } from '../../api/providers'
import type { ChatMessage } from '../../api/providers/types'
import { modelSeesImages } from '../../api/computer-executor'
import { useModelStore } from '../../stores/modelStore'
import { runInLane } from '../run-slot'
import { isThinkingCompatible } from '../model-compatibility'
import { laneOf, currentLaneFacts } from '../run-lane-of-model'
import { cleanTrainDescription } from '../train-captions'
import { DESCRIBE_STYLE_SYSTEM, type TrainKind } from '../train-kind'

export interface DescribeAvailability {
  available: boolean
  /** What the button's tooltip says: what it does, or why it cannot run. */
  hint: string
}

const HINT_READY = 'Your local chat model looks at each photo and fills in the empty fields. Runs on your machine.'
const HINT_NO_MODEL = 'Pick a local chat model that can see images in Chat first.'
const HINT_NOT_LOCAL = 'Describing photos runs only with a local chat model. Pick one that can see images in Chat.'
const HINT_NO_VISION = 'Your chat model cannot see images. Pick a local one that can, in Chat.'

/** The turn id the descriptions queue under, apart from any chat turn. */
const DESCRIBE_TURN = 'create::describe-train-photos'
const DESCRIBE_TIMEOUT_MS = 90_000
const DESCRIBE_MAX_TOKENS = 120

export const DESCRIBE_SYSTEM = [
  'You caption photos for training a character LoRA.',
  'Name ONLY what can change between photos of the same character: clothing, hairstyle, accessories, makeup, background or place, lighting, pose, framing.',
  'Never describe the face, facial features, eye color, skin, body shape, age, gender or identity, and never guess a name.',
  'Answer with one line of short comma separated phrases, at most 15 words, no sentence, no quotes, nothing else.',
].join('\n')

/** Is "Describe photos" usable with the chat model picked right now? */
export async function describeAvailability(): Promise<DescribeAvailability> {
  const model = useModelStore.getState().activeModel
  if (!model) return { available: false, hint: HINT_NO_MODEL }
  if (laneOf(model, currentLaneFacts()) !== 'local') return { available: false, hint: HINT_NOT_LOCAL }
  const sees = await modelSeesImages(model).catch(() => false)
  return sees ? { available: true, hint: HINT_READY } : { available: false, hint: HINT_NO_VISION }
}

const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi
const OPEN_THINK = /<think(?:ing)?>[\s\S]*$/i
const REFUSAL = /^(i['’]m sorry|i am sorry|sorry[,.]|i can['’]?t|i cannot|i['’]m unable|i am unable|as an ai)/i
const LABEL = /^(caption|description|answer|output)\s*[:-]\s*/i

/** The model's raw answer, made into a description, or null when unusable. */
export function cleanDescription(raw: string): string | null {
  let text = raw.replace(THINK_BLOCK, '')
  if (OPEN_THINK.test(text)) return null
  text = text.trim().split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  text = text.replace(LABEL, '').replace(/^["'`*\s-]+|["'`*\s]+$/g, '')
  if (!text || REFUSAL.test(text)) return null
  const clean = cleanTrainDescription(text)
  return clean || null
}

/** The photo as base64 for the chat model, at most 768 px on its long side
 *  when the browser can scale it (a 12 MP phone photo is 20 times the pixels
 *  a description needs). Falls back to the bytes as they are. */
async function photoForModel(blob: Blob): Promise<{ data: string; mimeType: string }> {
  try {
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
      const bmp = await createImageBitmap(blob)
      const scale = Math.min(1, 768 / Math.max(bmp.width, bmp.height))
      const w = Math.max(1, Math.round(bmp.width * scale))
      const h = Math.max(1, Math.round(bmp.height * scale))
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(bmp, 0, 0, w, h)
        bmp.close()
        const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
        return { data: await base64Of(jpeg), mimeType: 'image/jpeg' }
      }
      bmp.close()
    }
  } catch { /* scale failed, send the original */ }
  return { data: await base64Of(blob), mimeType: blob.type || 'image/png' }
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** One photo's description from the local chat model, or null. */
export async function describeTrainPhoto(blob: Blob, signal?: AbortSignal, kind: TrainKind = 'character'): Promise<string | null> {
  const model = useModelStore.getState().activeModel
  if (!model || signal?.aborted) return null
  if (laneOf(model, currentLaneFacts()) !== 'local') return null
  try {
    const { provider, modelId } = getProviderForModel(model)
    // Same reasoning switch as the prompt rewrite (improve-prompt-run.ts): off
    // where the model can switch it off, the lowest rung everywhere else.
    const meta = useModelStore.getState().models.find((m) => m.name === model)
    const thinkMode = meta && 'thinkMode' in meta ? meta.thinkMode : undefined
    const canThink = thinkMode ? thinkMode === 'toggle' : isThinkingCompatible(model)
    const effortLevels = meta && 'effortLevels' in meta ? meta.effortLevels : undefined
    const effortDefault = meta && 'effortDefault' in meta ? meta.effortDefault : undefined
    const image = await photoForModel(blob)
    const messages: ChatMessage[] = [
      { role: 'system', content: kind === 'style' ? DESCRIBE_STYLE_SYSTEM : DESCRIBE_SYSTEM },
      { role: 'user', content: 'Caption this photo.', images: [image] },
    ]
    const own = new AbortController()
    let stop: () => void = () => {}
    const stopped = new Promise<false>((resolve) => { stop = () => { own.abort(); resolve(false) } })
    signal?.addEventListener('abort', stop)
    let timer: ReturnType<typeof setTimeout> | undefined
    let text = ''
    let ran = false
    const run = runInLane(
      { conversationId: DESCRIBE_TURN, lane: 'local', abort: () => stop() },
      async () => {
        if (own.signal.aborted) return
        timer = setTimeout(stop, DESCRIBE_TIMEOUT_MS)
        const read = (async () => {
          const stream = provider.chatStream(modelId, messages, {
            temperature: 0.2,
            maxTokens: DESCRIBE_MAX_TOKENS,
            thinking: canThink ? false : undefined,
            reasoningEffort: 'low',
            effortLevels,
            effortDefault,
            signal: own.signal,
          })
          for await (const chunk of stream) {
            if (chunk.content) text += chunk.content
            if (chunk.done) break
          }
          return true as const
        })()
        read.catch(() => {})
        ran = await Promise.race([read, stopped])
      },
    ).then((outcome) => outcome === 'ran' && ran)
    run.catch(() => {})
    let finished = false
    try {
      finished = await Promise.race([run, stopped])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
    }
    return finished ? cleanDescription(text) : null
  } catch {
    return null
  }
}
