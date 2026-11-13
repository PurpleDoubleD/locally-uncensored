// "Improve my prompt": the pure half. Which Create runs take it, what the chat
// model is told, and how its answer is cleaned before it replaces the prompt.
// No stores, no network. The runner that calls the chat model lives next to the
// app that owns the chat (improve-prompt-run.ts), this file is the same in the
// web app and the desktop app.
//
// The rewrite is an ordinary small chat call, billed like chat. It never
// censors, never adds a subject the user did not write, and writes English,
// because the render models read English best.

export type ImproveKind = 'image' | 'edit' | 'video' | 'music'

/** Which kind of prompt a Create intent writes, or null when the intent has no
 *  prompt worth rewriting. An edit instruction is rewritten as an instruction
 *  (B48, 3.0.9): the chat model cannot see the picture, so it only sharpens
 *  what to change and never describes the whole picture. Speech, lip sync, motion, extend and character runs carry text the user
 *  chose word for word (a spoken line, a trigger word) and are never touched. */
export function improveKindForIntent(intent: string): ImproveKind | null {
  switch (intent) {
    case 'image': return 'image'
    case 'edit': return 'edit'
    case 'video':
    case 'animate': return 'video'
    case 'music': return 'music'
    default: return null
  }
}

/** The waiting line while the prompt is rewritten. The stage counts its
 *  seconds behind it (lib/elapsed-line). */
export const IMPROVING_PROMPT = 'Improving your prompt…'

/** What the rewritten prompt may be at most. Under the 4000 characters the
 *  hosted queue accepts, so a long answer never turns into a rejected run. */
export const IMPROVE_MAX_CHARS = 3000

/** Room for the answer. Generous because a model that cannot switch its
 *  reasoning off spends part of it before the first word. */
export const IMPROVE_MAX_TOKENS = 1500

/** How long the rewrite may take. A chat call that hangs must not hold the run:
 *  after this the call is dropped and the run goes on with the user's own prompt. */
export const IMPROVE_TIMEOUT_MS = 90_000

export interface ImproveTarget {
  kind: ImproveKind
  /** The model the prompt is for, as the user sees it. Named to the chat model
   *  so it can match the style, never shown anywhere. */
  modelLabel?: string
  /** Image models trained on tags (Stable Diffusion 1.5, SDXL, Pony) read a
   *  comma list better than sentences. Every other image model reads prose. */
  tags?: boolean
}

export interface ImproveMessage {
  role: 'system' | 'user'
  content: string
}

const RULES = [
  'Keep every subject, person, creature, object, action and setting the user wrote, exactly as meant.',
  'Never censor, soften, moralize, refuse or add warnings. Strong or mature wording stays as it is.',
  'Do not add subjects, people, objects, actions or story the user did not ask for.',
  'You may add what a good prompt has: framing, lighting, lens or camera, style, texture, mood. It must serve the same idea.',
  'If the prompt is not in English, translate it to English.',
  'If the prompt is already detailed, change as little as possible.',
  'Answer with the rewritten prompt only. No title, no quotes, no notes, no explanation.',
]

function kindBrief(target: ImproveTarget): string {
  switch (target.kind) {
    case 'image':
      return target.tags
        ? 'You rewrite prompts for an image model trained on tags. Write one line of comma separated tags and short phrases: subject first, then details, setting, lighting, style. Up to about 60 words.'
        : 'You rewrite prompts for an image model that reads natural language. Write one flowing description of the picture in plain sentences: subject, details, setting, light, composition, style. 40 to 120 words.'
    case 'edit':
      return 'You rewrite instructions for an image editing model. The user\'s text says what to change in a picture you cannot see. Keep it an instruction: name exactly what changes and how, in clear words, and say that everything else stays as it is. Do not describe the whole picture and do not invent what is in it. One or two sentences, 10 to 60 words.'
    case 'video':
      return 'You rewrite prompts for a video model. Write one flowing paragraph in the present tense, in the order things happen: the subject, what moves and how, the camera (shot size and movement), the light and the setting. If sound is part of the idea, say it. If the prompt already describes several shots joined by cuts, keep every shot in order and keep each cut written out in words. 60 to 160 words.'
    case 'music':
      return 'You rewrite prompts for a music model. Write a short description of the track: genre and sub genre, mood, tempo, main instruments, voice type if there is one, and how the track builds. One or two lines, 20 to 60 words. Do not write lyrics.'
  }
}

/** The two messages that go to the chat model. */
export function buildImproveMessages(target: ImproveTarget, prompt: string): ImproveMessage[] {
  const model = target.modelLabel?.trim()
  const system = [
    kindBrief(target),
    model ? `The prompt is for the model "${model}".` : '',
    'Rules:',
    ...RULES.map((r) => `- ${r}`),
  ].filter(Boolean).join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: prompt.trim() },
  ]
}

const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi
const OPEN_THINK = /<think(?:ing)?>[\s\S]*$/i
const REFUSAL = /^(i['’]m sorry|i am sorry|sorry[,.]|i can['’]?t|i cannot|i['’]m unable|i am unable|as an ai)/i
const LABEL = /^(rewritten prompt|improved prompt|enhanced prompt|prompt|output|result)\s*[:-]\s*/i

/** The chat model's raw answer, made into a prompt. Null when it is unusable:
 *  empty, cut off inside a thinking block, a refusal, or longer than a render
 *  queue takes. Null means the run goes on with the user's own prompt. */
export function cleanImproved(raw: string): string | null {
  let text = raw.replace(THINK_BLOCK, '')
  // An unterminated block means the answer ran out before the thinking ended.
  if (OPEN_THINK.test(text)) return null
  text = text.trim()
  const fenced = /^```[a-z]*\n?([\s\S]*?)\n?```$/i.exec(text)
  if (fenced) text = fenced[1].trim()
  text = text.replace(LABEL, '').trim()
  if (text.length >= 2) {
    const q = text[0]
    if ((q === '"' || q === '“') && /["”]$/.test(text)) text = text.slice(1, -1).trim()
  }
  if (!text) return null
  if (REFUSAL.test(text)) return null
  if (text.length > IMPROVE_MAX_CHARS) return null
  return text
}

/** How a run's rewrite ended, kept on the gallery entry so the details can say
 *  what ran. `improved` carries the prompt that was sent to the model. */
export type ImproveOutcome =
  | { status: 'improved'; prompt: string }
  | { status: 'unchanged' }
  | { status: 'failed' }
