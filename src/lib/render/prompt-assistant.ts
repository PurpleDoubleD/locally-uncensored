// The prompt assistant in Create (B43, 3.0.9): a few keywords in, a prompt
// written the way the picked model reads best out. The pure half: which model
// family the run is for, the built-in templates of each family, and the draft
// a template makes from the keywords without any model. Refining the draft
// with the chat model is the existing "Improve my prompt" call
// (improve-prompt-run.ts), with the same rules: it keeps every subject, never
// censors and adds nothing the user did not ask for.

import type { ImproveKind, ImproveTarget } from './improve-prompt'

/**
 * How a model wants its prompt.
 *
 * - `tags-sd15`, `tags-sdxl`: Stable Diffusion checkpoints, trained on comma
 *   separated tags (the same split "Improve my prompt" makes with `tags`).
 * - `tags-pony`: Pony Diffusion and its merges, SDXL underneath but trained
 *   with the score and source tags in front.
 * - `prose`: every newer image model (Flux, Qwen-Image, Z-Image, HiDream,
 *   SD3, Chroma, Lumina, …) reads natural sentences.
 * - `video`, `music`: one family each, the brief differs per kind, not per model.
 */
export type PromptFamily = 'tags-sd15' | 'tags-sdxl' | 'tags-pony' | 'prose' | 'video' | 'music'

export const FAMILY_LABEL: Record<PromptFamily, string> = {
  'tags-sd15': 'Stable Diffusion 1.5 (tags)',
  'tags-sdxl': 'SDXL (tags)',
  'tags-pony': 'Pony (score tags)',
  prose: 'Natural language',
  video: 'Video',
  music: 'Music',
}

/** The family of the model a run is for. `modelType` is what the model list
 *  or `classifyModel` says, `modelName` catches Pony, which classifies as SDXL. */
export function familyFor(kind: ImproveKind, modelType: string, modelName = ''): PromptFamily {
  if (kind === 'music') return 'music'
  if (kind === 'video') return 'video'
  if (modelType === 'sd15') return 'tags-sd15'
  if (modelType === 'sdxl') return /pony/i.test(modelName) ? 'tags-pony' : 'tags-sdxl'
  return 'prose'
}

export function isTagFamily(family: PromptFamily): boolean {
  return family === 'tags-sd15' || family === 'tags-sdxl' || family === 'tags-pony'
}

export interface PromptTemplate {
  id: string
  label: string
  /** `{k}` is where the keywords go. For tag families the text is a tag list. */
  pattern: string
}

/** The keywords as the user typed them: split on commas and new lines,
 *  trimmed, empty pieces dropped, duplicates kept once. */
export function splitKeywords(input: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input.split(/[,\n;]+/)) {
    const k = raw.trim().replace(/\s+/g, ' ')
    if (!k || seen.has(k.toLowerCase())) continue
    seen.add(k.toLowerCase())
    out.push(k)
  }
  return out
}

const PONY = 'score_9, score_8_up, score_7_up'

/** The built-in library, per family. Every template keeps the user's words
 *  first and only adds the craft a good prompt for that family has. */
export const TEMPLATES: Record<PromptFamily, PromptTemplate[]> = {
  'tags-sd15': [
    { id: 'photo', label: 'Photo', pattern: 'masterpiece, best quality, {k}, photorealistic, natural lighting, sharp focus, detailed skin texture, 85mm, bokeh' },
    { id: 'anime', label: 'Anime', pattern: 'masterpiece, best quality, {k}, anime style, clean lineart, vibrant colors, detailed eyes, soft shading' },
    { id: 'fantasy', label: 'Fantasy art', pattern: 'masterpiece, best quality, {k}, fantasy art, epic composition, dramatic lighting, intricate details, concept art' },
    { id: 'portrait', label: 'Portrait', pattern: 'masterpiece, best quality, {k}, portrait, looking at viewer, upper body, studio lighting, detailed face' },
  ],
  'tags-sdxl': [
    { id: 'photo', label: 'Photo', pattern: '{k}, photograph, realistic, natural light, shallow depth of field, 50mm lens, high detail, film grain' },
    { id: 'cinematic', label: 'Cinematic', pattern: '{k}, cinematic still, dramatic lighting, anamorphic, color graded, atmospheric, wide shot' },
    { id: 'anime', label: 'Anime', pattern: '{k}, anime illustration, clean lineart, cel shading, vibrant colors, detailed background' },
    { id: 'portrait', label: 'Portrait', pattern: '{k}, portrait, close-up, soft key light, rim light, detailed eyes, sharp focus' },
  ],
  'tags-pony': [
    { id: 'anime', label: 'Anime', pattern: `${PONY}, source_anime, {k}, detailed, vibrant colors` },
    { id: 'realistic', label: 'Realistic', pattern: `${PONY}, source_photo, photorealistic, {k}, natural lighting, detailed skin` },
    { id: 'cartoon', label: 'Cartoon', pattern: `${PONY}, source_cartoon, {k}, bold outlines, flat colors` },
    { id: 'furry', label: 'Furry', pattern: `${PONY}, source_furry, {k}, detailed fur, expressive` },
  ],
  prose: [
    { id: 'photo', label: 'Photo', pattern: 'A photograph of {k}. Natural light, shallow depth of field, shot on a 50mm lens, sharp focus and realistic textures.' },
    { id: 'cinematic', label: 'Cinematic', pattern: 'A cinematic film still of {k}. Dramatic lighting, anamorphic framing, rich color grading and atmospheric depth.' },
    { id: 'illustration', label: 'Illustration', pattern: 'A detailed digital illustration of {k}. Clean line work, vibrant colors and painterly shading.' },
    { id: 'portrait', label: 'Portrait', pattern: 'A close portrait of {k}. Soft key light from the side, a gentle rim light, detailed eyes, a calm neutral background.' },
    { id: 'product', label: 'Product', pattern: 'A studio product photo of {k} on a seamless background. Softbox lighting, crisp reflections, high detail.' },
  ],
  video: [
    { id: 'push-in', label: 'Slow push-in', pattern: '{k}. The camera slowly pushes in from a wide shot to a medium shot. Soft natural light, gentle motion, realistic detail.' },
    { id: 'action', label: 'Action', pattern: '{k}. Fast, energetic motion, the handheld camera follows the subject closely. Dynamic lighting, motion blur.' },
    { id: 'orbit', label: 'Orbit', pattern: '{k}. The camera orbits slowly around the subject at eye level. Smooth, steady movement, cinematic lighting.' },
    { id: 'b-roll', label: 'Nature b-roll', pattern: '{k}. A calm, steady wide shot, subtle movement in the scene, golden hour light, ambient sound of the place.' },
  ],
  music: [
    { id: 'song', label: 'Song', pattern: '{k}. Verse and chorus structure, a clear lead vocal, full band arrangement, builds into a big final chorus.' },
    { id: 'instrumental', label: 'Instrumental', pattern: '{k}. Instrumental, no vocals, a memorable main melody, steady groove, builds layer by layer.' },
    { id: 'ambient', label: 'Ambient', pattern: '{k}. Slow ambient soundscape, soft pads, wide reverb, gentle evolving textures, no drums.' },
    { id: 'beat', label: 'Beat', pattern: '{k}. Punchy drums, deep bass, catchy loop, around 90 BPM, modern mix.' },
  ],
}

/** The draft a template makes from the keywords, no model involved. Empty
 *  keywords give an empty draft: a template alone is not a prompt. */
export function buildFromTemplate(template: PromptTemplate, keywords: string): string {
  const parts = splitKeywords(keywords)
  if (parts.length === 0) return ''
  return template.pattern.replace('{k}', parts.join(', '))
}

/** What "Refine" asks the chat model for: the existing Improve call, aimed at
 *  this family and this model. */
export function refineTarget(kind: ImproveKind, family: PromptFamily, modelLabel?: string): ImproveTarget {
  return { kind, modelLabel: modelLabel || undefined, tags: isTagFamily(family) }
}
