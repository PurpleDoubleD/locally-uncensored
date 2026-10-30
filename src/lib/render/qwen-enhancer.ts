// The Qwen-Image 2.1 prompt enhancer as a writer for "Improve my prompt"
// (GH #148): the pure half. Which files are enhancers, which one a run takes,
// what the switch offers, and how the enhancer's answer becomes a prompt. No
// stores, no network; the graph and the run live in api/qwen-enhancer.ts, and
// on a Mac the run is api/mlx-enhancer.ts with the MLX editions of the models.
//
// Read off the sources on 2026-10-03:
//   - Comfy-Org/Qwen-Image-2.1 ships the two official enhancers as single
//     files for the text_encoders folder: one for text to image (t2i) and one
//     for edits (i2i), which also reads the pictures.
//   - Adahm/PE-Heretic-INT8-ConvRot-for-Qwen-Image-2.1 ships the community
//     editions without refusals in the same format, built from
//     pottokao/Qwen-Image-2.1-PE-T2I-Heretic and
//     darrellbest/Qwen-Image-2.1-PE-I2I-Heretic.
// A t2i file cannot stand in for an i2i file or the other way round: each was
// trained for its own task and its own system prompt.

import type { ImproveOutcome } from './improve-prompt'
import { modelDisplayLabel } from '../model-label'

/** What the enhancer rewrites: a prompt for a new picture, or an edit instruction. */
export type QwenEnhancerMode = 't2i' | 'i2i'

/** The official file, or a community edition with the refusals removed. */
export type QwenEnhancerVariant = 'official' | 'unfiltered'

export interface QwenEnhancerFile {
  /** The name ComfyUI lists, with its subfolder when it has one. */
  file: string
  mode: QwenEnhancerMode
  variant: QwenEnhancerVariant
}

const ENHANCER_NAME = /qwen[_-]image[_-]2\.1[_-]pe[_-](t2i|i2i)/i
const UNFILTERED_NAME = /heretic|abliterat/i

/** Is this text encoder file a Qwen-Image 2.1 prompt enhancer, and which one?
 *  The name is the only thing ComfyUI tells us, and every published single
 *  file edition carries "qwen_image_2.1_pe_t2i" or "..._i2i" in it. */
export function qwenEnhancerFile(file: string): QwenEnhancerFile | null {
  const base = file.split(/[\\/]/).pop() ?? file
  const match = ENHANCER_NAME.exec(base)
  if (!match) return null
  return {
    file,
    mode: match[1].toLowerCase() === 'i2i' ? 'i2i' : 't2i',
    variant: UNFILTERED_NAME.test(base) ? 'unfiltered' : 'official',
  }
}

/** A prompt enhancer is a text model, not a text encoder for a picture model.
 *  The encoder search must never pick one. */
export function isQwenEnhancerFile(file: string): boolean {
  return qwenEnhancerFile(file) !== null
}

/** The enhancers among ComfyUI's text encoder files. */
export function installedQwenEnhancers(textEncoders: readonly string[]): QwenEnhancerFile[] {
  return textEncoders.map(qwenEnhancerFile).filter((f): f is QwenEnhancerFile => f !== null)
}

/** Who rewrites the prompt. 'auto' is the default: the enhancer when one is
 *  there, the official one first, otherwise the chat model. */
export type ImproveWith = 'auto' | 'chat' | QwenEnhancerVariant

export const IMPROVE_WITH: readonly ImproveWith[] = ['auto', 'chat', 'official', 'unfiltered']

export interface ImproveWriter {
  id: 'chat' | QwenEnhancerVariant
  label: string
}

const WRITER_LABEL: Record<ImproveWriter['id'], string> = {
  official: 'Qwen enhancer',
  unfiltered: 'Qwen enhancer, No Filter',
  chat: 'Chat model',
}

/** The name "Prompt details" gives the writer of a rewrite: the enhancer
 *  edition, or the chat model by its own name. */
export function rewrittenByName(
  writer: ImproveWriter['id'],
  chatModel: string | null,
  /** The chat model list. It carries the display name the picker shows
   *  ("Kimi K2.6"); without it the short form of the id stands. */
  models: ReadonlyArray<{ name: string; displayName?: string }> = [],
): string {
  if (writer !== 'chat') return WRITER_LABEL[writer]
  return chatModel ? modelDisplayLabel(models, chatModel) : WRITER_LABEL.chat
}

export interface EnhancerSituation {
  /** Create runs on this machine: through ComfyUI, or on a Mac through MLX. */
  local: boolean
  /** The Create intent: 'image' writes a new picture, 'edit' changes one. */
  intent: string
  /** The family of the picked image model. Only 'qwenimage' has an enhancer. */
  modelType: string | null | undefined
  /** ComfyUI's text encoder files, or on a Mac the installed MLX enhancers
   *  (`enhancerNames`). */
  textEncoders: readonly string[]
}

/** Which task the enhancer would have here, or null when it has none: only a
 *  local Qwen-Image 2.1 run, for a new picture or for an edit. */
export function qwenEnhancerMode(s: Pick<EnhancerSituation, 'local' | 'intent' | 'modelType'>): QwenEnhancerMode | null {
  if (!s.local || s.modelType !== 'qwenimage') return null
  if (s.intent === 'image') return 't2i'
  if (s.intent === 'edit') return 'i2i'
  return null
}

/** The enhancers that fit this run, official first. */
function fitting(s: EnhancerSituation): QwenEnhancerFile[] {
  const mode = qwenEnhancerMode(s)
  if (!mode) return []
  const files = installedQwenEnhancers(s.textEncoders).filter((f) => f.mode === mode)
  const first = (variant: QwenEnhancerVariant) => files.find((f) => f.variant === variant)
  return [first('official'), first('unfiltered')].filter((f): f is QwenEnhancerFile => !!f)
}

/** What the switch lets the user choose between. Empty when no enhancer fits:
 *  then there is nothing to choose and the chat model writes, as before. An
 *  edit has no chat model entry, a chat model cannot see the picture. */
export function improveWriters(s: EnhancerSituation): ImproveWriter[] {
  const files = fitting(s)
  if (files.length === 0) return []
  const writers: ImproveWriter[] = files.map((f) => ({ id: f.variant, label: WRITER_LABEL[f.variant] }))
  if (s.intent === 'image') writers.push({ id: 'chat', label: WRITER_LABEL.chat })
  return writers
}

/** The enhancer file this run takes, or null when the chat model writes (or,
 *  on an edit without an enhancer, nobody does). The user's choice wins when
 *  that edition is installed; otherwise the first one that fits. */
export function pickQwenEnhancer(s: EnhancerSituation, choice: ImproveWith): QwenEnhancerFile | null {
  const files = fitting(s)
  if (files.length === 0) return null
  if (choice === 'chat' && s.intent === 'image') return null
  return files.find((f) => f.variant === choice) ?? files[0]
}

/** The entry the choice row marks. */
export function activeWriter(s: EnhancerSituation, choice: ImproveWith): ImproveWriter['id'] | null {
  if (improveWriters(s).length === 0) return null
  return pickQwenEnhancer(s, choice)?.variant ?? 'chat'
}

export const QWEN_ENHANCER_HINT =
  'The Qwen prompt enhancer rewrites your prompt for Qwen-Image 2.1. It runs on your machine before the picture starts. It does not replace the text encoder: that is part of the image model and reads the rewritten prompt.'

/** The line under the switch while the enhancer writes. Discord report
 *  (3.0.7): with the enhancer on, a user asked why a text encoder is still
 *  picked. One line says the two do different jobs, on every platform. */
export const QWEN_ENHANCER_LINE =
  'Rewrites your prompt first. The text encoder, part of the image model, then reads it.'

const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi
const OPEN_THINK = /<think(?:ing)?>[\s\S]*$/i
const REFUSAL = /^(i['’]m sorry|i am sorry|sorry[,.]|i can['’]?t|i cannot|i['’]m unable|i am unable|as an ai)/i

/** The enhancer's answer, made into a prompt. The system prompts ask for one
 *  plain paragraph; Qwen's own format is a JSON object with the prompt in
 *  `rewritten_prompt`, so an answer that still comes that way is unwrapped.
 *  Null when it is unusable: empty, cut off inside its reasoning, or a
 *  refusal. There is no length limit, this model is made for long prompts. */
export function cleanEnhanced(raw: string): string | null {
  let text = raw.replace(THINK_BLOCK, '')
  if (OPEN_THINK.test(text)) return null
  text = text.trim()
  const fenced = /^```[a-z]*\n?([\s\S]*?)\n?```$/i.exec(text)
  if (fenced) text = fenced[1].trim()
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      const field = parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).rewritten_prompt
        : undefined
      // A JSON object without the prompt in it is not a prompt.
      if (typeof field !== 'string') return null
      text = field.trim()
    } catch {
      // Braces that are not JSON: an answer cut off mid object.
      return null
    }
  }
  // One paragraph, as the system prompts ask: a stray line break is a space.
  text = text.replace(/\s*\n+\s*/g, ' ').trim()
  if (!text) return null
  if (REFUSAL.test(text)) return null
  return text
}

/** The outcome of an enhancer answer, in the words "Improve my prompt" uses. */
export function enhancedOutcome(raw: string | null, original: string): ImproveOutcome {
  const cleaned = raw === null ? null : cleanEnhanced(raw)
  if (!cleaned) return { status: 'failed' }
  if (cleaned === original.trim()) return { status: 'unchanged' }
  return { status: 'improved', prompt: cleaned }
}

const END_OF_TURN = /(?:\s*<\|(?:im_end|endoftext)\|>)+\s*$/
const OPENS_THINK = /<think(?:ing)?>/i

/** The outcome of the enhancer's answer on a Mac (commands/mlx_enhancer.rs).
 *  There the model's own template opens the reasoning: `<think>` is the last
 *  piece of the prompt, so the answer starts inside the reasoning and carries
 *  only its closing tag. Put back, it reads like the answer Windows gets, and
 *  an answer cut off before the reasoning closed fails as it does there. */
export function mlxEnhancedOutcome(raw: string | null, original: string): ImproveOutcome {
  if (raw === null) return enhancedOutcome(null, original)
  const text = raw.replace(END_OF_TURN, '')
  return enhancedOutcome(OPENS_THINK.test(text) ? text : `<think>${text}`, original)
}

/** The names the enhancer is found by: ComfyUI's text encoder files, or on a
 *  Mac the catalogue ids of the installed MLX enhancers, which carry the same
 *  "qwen-image-2.1-pe-t2i" or "-i2i" (lib/image-engines `installedMlxEnhancers`).
 *  On a Mac only a model of the MLX branch takes the enhancer: a ComfyUI model
 *  there keeps the chat model's rewrite, so none is found for it. The switch
 *  and the run both ask this, and so offer and run the same writer. */
export function enhancerNames(
  where: { onMac: boolean; mlxModel: boolean },
  textEncoders: readonly string[],
  macEnhancers: readonly string[],
): readonly string[] {
  if (!where.onMac) return textEncoders
  return where.mlxModel ? macEnhancers : []
}

/** What the Qwen enhancer's progress looks like here; the run reports it
 *  (api/qwen-enhancer.ts `EnhancerProgress`). */
export type EnhancerPhase =
  | { phase: 'queued' }
  | { phase: 'loading' }
  | { phase: 'reading' }
  | { phase: 'writing'; tokens: number; max: number; tokensPerSecond: number | null }

/**
 * The waiting line while the enhancer works (B41, 3.0.9). A user waited 530 s
 * on "Improving your prompt…" with nothing but the seconds moving. Now the
 * line says which part is running, and while it writes, how many tokens it
 * has and how fast it goes: a card that writes one token a second shows it
 * at once, instead of after minutes. `max` is the limit, not a goal: the
 * enhancer stops at its own end, usually long before.
 */
export function enhancerLine(p: EnhancerPhase, mode: QwenEnhancerMode, limitMinutes: number): string {
  switch (p.phase) {
    case 'queued':
      return 'Improving your prompt: waiting for ComfyUI…'
    case 'loading':
      return 'Improving your prompt: loading the prompt enhancer…'
    case 'reading':
      return mode === 'i2i'
        ? 'Improving your prompt: the enhancer reads your prompt and pictures…'
        : 'Improving your prompt: the enhancer reads your prompt…'
    case 'writing': {
      const rate = p.tokensPerSecond === null ? '' : `, ${p.tokensPerSecond >= 10 ? Math.round(p.tokensPerSecond) : Math.round(p.tokensPerSecond * 10) / 10} tokens/s`
      const slow = p.tokensPerSecond !== null && p.tokensPerSecond < 3
        ? ` Slow: the enhancer does not fit on the graphics card next to everything else. LU gives up after ${limitMinutes} min and uses your own prompt.`
        : ''
      return `Improving your prompt: ${p.tokens} of up to ${p.max} tokens${rate}…${slow}`
    }
  }
}
