// Swap Character: a real video stays as it is (motion, camera, sound, scene),
// and the people in it become the people of the customer's photos.
//
// Port of the web app's lib/render/swap.ts (07.11.2026, C52; two steps with
// SCAIL 2 and Kling since 14.11.2026), cut to the one mode the desktop offers. The web also has Swap Scene and Swap Both; the
// desktop does not, so only the rules of Swap Character are here. The names,
// numbers and sentences are the web's, so a run from either app books and
// reads the same.
//
// Models, the recommended first (after the real runs of 13./14.11.2026):
//   scail-2                      1 to 3 people, mode replace, up to 120 s. Its
//                                image is the first frame of the video with
//                                the new people already in it (Nano Banana
//                                Pro builds it first, the customer checks it).
//   kling-v3-pro-motion-control  the same two steps for one person, at the
//                                highest resolution, chosen by hand only.
//   openjutsu-character-swap     1 to 4 people, one photo and an optional role
//                                each, at most the first 15 seconds, one step.
//   wan-2.2-animate-replace      one person, up to 120 seconds, mode replace,
//                                one step.

import { STUDIO_MODELS, studioSchema } from './studio-contract'

export const SWAP_INTENT = 'swap_character' as const
export type SwapIntent = typeof SWAP_INTENT

export function isSwapIntent(intent: string): intent is SwapIntent {
  return intent === SWAP_INTENT
}

/** The models of Swap Character, the recommended first. */
export const SWAP_MODELS: readonly string[] = ['scail-2', 'kling-v3-pro-motion-control', 'openjutsu-character-swap', 'wan-2.2-animate-replace']

/** The recommended model (up to 3 people, up to 120 s). */
export const SWAP_MAIN_MODEL = 'scail-2'
/** One person at the highest resolution, picked by hand only. */
export const SWAP_KLING_MODEL = 'kling-v3-pro-motion-control'
/** Four people with roles, at most 15 s, one step. */
export const SWAP_OPENJUTSU_MODEL = 'openjutsu-character-swap'
/** One person, long and cheap, one step. */
export const SWAP_LONG_MODEL = 'wan-2.2-animate-replace'

/** The first frame models: their image is the first frame of the video with
 *  the new people already in it (two steps). */
export const SWAP_FRAME_MODELS: readonly string[] = [SWAP_MAIN_MODEL, SWAP_KLING_MODEL]

/** Does Swap Character run in two steps on this model (the frame first, then
 *  the video)? */
export function swapUsesFrame(intent: string, model: string): boolean {
  return isSwapIntent(intent) && SWAP_FRAME_MODELS.includes(model)
}

/** What the mode fixes and the customer therefore never sees. SCAIL 2 and
 *  Wan 2.2 Animate run as replace here: as animate they would put the new
 *  person in front of a new background, which is Motion Control. Kling
 *  follows the orientation of the video and keeps the original sound. */
export function swapFixedOptions(intent: string, model: string): Record<string, unknown> {
  if (!isSwapIntent(intent)) return {}
  if (model === SWAP_MAIN_MODEL || model === SWAP_LONG_MODEL) return { mode: 'replace' }
  if (model === SWAP_KLING_MODEL) return { character_orientation: 'video', keep_original_sound: true }
  return {}
}

/** What Swap Character presets on a model while the customer picks nothing:
 *  SCAIL 2 at 720p (as in the real run). */
export function swapDefaultOptions(intent: string, model: string): Record<string, unknown> {
  return isSwapIntent(intent) && model === SWAP_MAIN_MODEL ? { resolution: '720p' } : {}
}

/** Fields the Swap panel shows itself (a role per person, the resolution) and
 *  the settings drawer therefore leaves out. `mode` is fixed (above). */
export function swapPanelFields(intent: string): string[] {
  return isSwapIntent(intent) ? ['roles', 'resolution', 'mode'] : []
}

/** How many people a model swaps in one run. SCAIL 2 is tested for real with
 *  2 and 3 people (13./14.11.2026), Kling is made for one. */
export function swapMaxPeople(model: string): number {
  if (model === SWAP_OPENJUTSU_MODEL) return 4
  if (model === SWAP_MAIN_MODEL) return 3
  return 1
}

/** Does the model read one role per photo (`roles`)? */
export function swapReadsRoles(model: string): boolean {
  return !!STUDIO_MODELS[model] && 'roles' in (studioSchema(model).properties ?? {})
}

/** The model Swap Character picks for this many people: up to 3 SCAIL 2 (long
 *  clips up to 120 s too), with 4 OpenJutsu. Kling only the customer picks. */
export function swapAutoModel(figures: number): string {
  return figures > swapMaxPeople(SWAP_MAIN_MODEL) ? SWAP_OPENJUTSU_MODEL : SWAP_MAIN_MODEL
}

/** The models the panel switches between by itself. */
export const SWAP_AUTO_MODELS: readonly string[] = [SWAP_MAIN_MODEL, SWAP_OPENJUTSU_MODEL]

// Length. The customer picks from the shortest length the model takes up to
// its real maximum. The server cuts the video (clip_seconds): the beginning
// of the video runs.

export interface SwapClipLimits {
  /** Shortest length the model takes. */
  min: number
  /** Longest length the model reads. */
  max: number
  /** The provider bills at least this many seconds. */
  billedMin: number
}

/** The limits of a model, from the catalogue (studio-models.json). OpenJutsu
 *  needs at least 2 seconds of video, Kling reads 3 to 30 seconds (their model
 *  pages). */
export function swapClipLimits(model: string): SwapClipLimits {
  const price = STUDIO_MODELS[model]?.price
  const max = price?.maxSeconds ?? 120
  const billedMin = price?.minSeconds ?? 3
  const min = model === SWAP_OPENJUTSU_MODEL ? 2 : model === SWAP_KLING_MODEL ? 3 : 1
  return { min, max, billedMin }
}

/** The length that runs: the choice, else the whole video, always inside the
 *  limits of the model and never longer than the video. */
export function swapClipSeconds(model: string, chosen: number | null, videoSeconds?: number): number {
  const { min, max } = swapClipLimits(model)
  const video = videoSeconds && Number.isFinite(videoSeconds) ? Math.floor(videoSeconds) : max
  const upper = Math.max(min, Math.min(max, video))
  return Math.max(min, Math.min(upper, chosen ?? upper))
}

/** The seconds the provider measures and bills (not rounded; it bills every
 *  started second). Without a choice the whole video runs up to the limit of
 *  the model, with one at most the chosen seconds: the server cuts longer.
 *  The slider, the Create button and the server count the same. A first frame
 *  model runs on whole seconds (swapWholeSeconds). */
export function swapPricedSeconds(model: string, chosen: number | null, videoSeconds: number): number {
  if (SWAP_FRAME_MODELS.includes(model)) return swapWholeSeconds(model, chosen, videoSeconds)
  const { max } = swapClipLimits(model)
  return Math.min(videoSeconds, chosen ?? max, max)
}

/** Whole seconds for SCAIL 2 and Kling in Swap. The provider bills every
 *  started second (6.006 s cost like 7 s, real run of 13.11.2026). When the
 *  clip reaches less than 0.1 s past a whole second, the server cuts it to one
 *  frame below that second; otherwise the started second counts. A chosen
 *  length always cuts to one frame below. Slider, button and booking name
 *  exactly this number. */
export function swapWholeSeconds(model: string, chosen: number | null, videoSeconds?: number): number {
  const { max } = swapClipLimits(model)
  const s = Math.min(videoSeconds && Number.isFinite(videoSeconds) ? videoSeconds : max, chosen ?? max, max)
  return Math.max(1, Math.ceil(s - 0.1))
}

/** Credits per second at the resolution picked. */
export function swapCreditsPerSecond(model: string, options: Record<string, unknown>): number | null {
  const m = STUDIO_MODELS[model]
  if (!m) return null
  const resolution = String(options[m.price.resolutionField ?? 'resolution'] ?? m.defaults?.resolution ?? Object.keys(m.price.rates)[0])
  const rate = m.price.rates[resolution]
  return rate === undefined ? null : Math.round(rate * 100000)
}

/** What one photo costs on top, in credits (price.perReference). */
export function swapCreditsPerPhoto(model: string): number {
  return Math.round((STUDIO_MODELS[model]?.price.perReference ?? 0) * 100000)
}

/** The photos a run is billed for: every photo the run sends, where the
 *  model bills them one by one (the main model). */
export function swapBilledPhotos(model: string, figures: number): number {
  return STUDIO_MODELS[model]?.price.perReference ? figures : 0
}

/** Credits for this many priced seconds and this many billed photos: the
 *  provider's rule (every started second, at least billedMin, plus each
 *  photo). The slider shows it; the price preview of the Create button gets
 *  the same number from studioCredits. */
export function swapClipCredits(model: string, options: Record<string, unknown>, seconds: number, photos: number): number | null {
  const perSecond = swapCreditsPerSecond(model, options)
  if (perSecond == null) return null
  const billed = Math.max(swapClipLimits(model).billedMin, Math.ceil(seconds))
  return perSecond * billed + photos * swapCreditsPerPhoto(model)
}

/** A price in few characters for the Create button (the web's CreateButton
 *  shortCredits): 950, 1.5k, 152k, 1.2M. */
export function swapShortCredits(credits: number): string {
  if (credits < 1000) return String(Math.round(credits))
  if (credits < 10_000) return `${(Math.round(credits / 100) / 10).toLocaleString('en-US')}k`
  if (credits < 1_000_000) return `${Math.round(credits / 1000).toLocaleString('en-US')}k`
  return `${(Math.round(credits / 100_000) / 10).toLocaleString('en-US')}M`
}

// People.

/** A new person: the photo, and who it replaces in the video. */
export interface SwapFigureSpec { role: string }

const ORDINAL = ['first', 'second', 'third', 'fourth']

/** Where the customer tapped in the first frame, as a share of width and
 *  height (0 to 1). */
export interface SwapMark { x: number; y: number }

const PLACE_2 = ['the person on the left', 'the person on the right']
const PLACE_3 = ['the person on the left', 'the person in the middle', 'the person on the right']

/** A description per mark from where it sits, in the order of the marks:
 *  sorted by x, left, in the middle, right. With one mark "the person". This
 *  is the default role, the customer can write over it. No detection runs and
 *  nothing is billed. */
export function swapMarkRoles(marks: readonly SwapMark[]): string[] {
  if (marks.length <= 1) return marks.map(() => 'the person')
  const order = marks.map((m, i) => ({ x: m.x, i })).sort((a, b) => a.x - b.x || a.i - b.i)
  const out: string[] = new Array(marks.length)
  order.forEach(({ i }, rank) => {
    out[i] = marks.length === 2 ? PLACE_2[rank]
      : marks.length === 3 ? PLACE_3[rank]
      : `the ${ORDINAL[rank] ?? `${rank + 1}th`} person from the left`
  })
  return out
}

/** The role of each person: what the customer writes, else where their mark
 *  sits. People without a mark keep their own role (empty: the main person). */
export function swapFigureRoles(figures: readonly { role: string; mark?: SwapMark | null }[]): string[] {
  const marked = figures.map((f, i) => ({ f, i })).filter(({ f }) => f.mark)
  const placed = swapMarkRoles(marked.map(({ f }) => f.mark!))
  const byIndex = new Map(marked.map(({ i }, k) => [i, placed[k]]))
  return figures.map((f, i) => f.role.trim().slice(0, 200) || byIndex.get(i) || '')
}

/** The roles as the provider gets them, or undefined. One photo without a role
 *  replaces the most prominent person. Once one role is set every photo needs
 *  one, or a role would land on the wrong photo; an empty role therefore gets
 *  its place from the left. */
export function swapRoles(figures: SwapFigureSpec[]): string[] | undefined {
  const roles = figures.map((f) => f.role.trim().slice(0, 200))
  if (roles.every((r) => !r)) return undefined
  return roles.map((r, i) => r || `the ${ORDINAL[i] ?? `${i + 1}th`} person from the left`)
}

/** The prompt of a swap run. A first frame model gets none: the built frame
 *  says it all (Kling ran without a prompt in the real test, SCAIL 2 replace
 *  needs none). Any other model gets the customer's text as it is. */
export function swapPrompt(intent: string, model: string, prompt: string): string {
  return swapUsesFrame(intent, model) ? '' : prompt
}

/** What stands in the panel before the start (from the test runs of
 *  06.11. and 13./14.11.2026), so it is not learned from a failed run. Grey,
 *  not a warning. */
export const SWAP_TIPS = [
  'One continuous shot, no hard cuts. Everyone you replace must be visible in the first frame.',
  'Up to 3 people with SCAIL-2, one person with Kling (highest resolution).',
  'Subtitles burned into the video may disappear. Heavy make-up or costumes can blend back in.',
] as const

/** The line above the first frame. */
export const SWAP_TAP_TEXT = 'Tap each person you want to replace'

// The first frame (two steps).

/** The image model that builds the first frame with the new people. */
export const SWAP_FRAME_MODEL = 'nano-banana-pro-edit'

/** The aspect ratios Nano Banana Pro knows (the provider's schema). */
const FRAME_ASPECTS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const

/** The allowed aspect ratio closest to the video. */
export function swapFrameAspect(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '9:16'
  const want = Math.log(width / height)
  let best: string = FRAME_ASPECTS[0], gap = Infinity
  for (const a of FRAME_ASPECTS) {
    const [w, h] = a.split(':').map(Number)
    const d = Math.abs(Math.log(w / h) - want)
    if (d < gap - 1e-9) { best = a; gap = d }
  }
  return best
}

/** The options of the frame step. 2k and JPEG as in the real test. */
export function swapFrameOptions(width: number, height: number): Record<string, unknown> {
  return { aspect_ratio: swapFrameAspect(width, height), resolution: '2k', output_format: 'jpeg' }
}

const IMAGE_ORDINAL = ['second', 'third', 'fourth', 'fifth']

/** The sentence of the frame step (template from the real runs of
 *  13./14.11.: without "No headset" and "same head angle" came headsets and
 *  frontal heads). The first image is the video frame, from the second on a
 *  photo per person. What the customer writes under "What's wrong?" goes at
 *  the end. */
export function swapFramePrompt(roles: readonly string[], extra?: string): string {
  const who = roles.length ? roles.map((r) => r.trim() || 'the person') : ['the person']
  const one = who.length === 1
  const replace = one
    ? `Replace ${who[0]} in the first image with the person from the second image.`
    : `In the first image, ${who.map((r, i) => `replace ${r} with the person from the ${IMAGE_ORDINAL[i]} image`).join(', ').replace(/, ([^,]*)$/, ' and $1')}.`
  const keep = one
    ? 'Keep the face identity, hair and facial features from the second image exactly.'
    : 'Keep the face identity, hair and facial features of each new person from their image exactly.'
  const rest = one
    ? 'Keep everything else from the first image identical: same pose, the same head angle as in the first image, same head size, mouth position, camera angle, framing, distance, clothing, background, lighting, colors, text overlays and phone-camera quality. It must look like the same raw phone video frame, just with the other person.'
    : `Every other person stays unchanged. Keep everything else from the first image identical: same poses, the same head angles as in the first image, same head sizes, mouth positions, camera angle, framing, distance, clothing, background, lighting, colors, text overlays and phone-camera quality. It must look like the same raw phone video frame, just with the other people.`
  const fix = extra?.trim() ? `Fix this from the last attempt: ${extra.trim().slice(0, 500)}` : ''
  return [
    replace, keep,
    one
      ? "Use the hair of the person from the second image and remove all of the original person's hair completely, even long hair."
      : "Use each new person's own hair from their image and remove all of the original people's hair completely, even long hair.",
    one ? 'No headset, no microphone.' : 'No headsets, no microphones.',
    rest, fix,
  ].filter(Boolean).join(' ')
}

/** A fingerprint of the inputs of the frame step. When the video, a photo, a
 *  mark or a role changes, the built frame no longer fits and expires. */
export function swapFrameKey(videoUrl: string, figures: readonly { imageUrl: string | null; role: string; mark?: SwapMark | null }[]): string {
  const parts = [videoUrl, ...figures.map((f) => `${hash(f.imageUrl ?? '')}|${f.role}|${f.mark ? `${f.mark.x.toFixed(3)},${f.mark.y.toFixed(3)}` : ''}`)]
  return parts.join('#')
}
function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `${text.length}:${h.toString(36)}`
}

/** The heading of a result in the gallery. */
export const SWAP_GALLERY_LABEL = 'Swap Character'

// Consent (07.11.2026, as on the web). The server refuses a run of these
// models without params.swap_consent === true (400, code
// swap_consent_required). The panel shows the box only for them, and Create
// and the frame step wait for the tick. The tick is runtime only and never
// stored. SCAIL 2 was missing until 14.11.2026 (gap: SCAIL 2 replace ran
// without the tick).

/** The models whose swap run needs the customer's confirmation. */
export const SWAP_CONSENT_MODELS: readonly string[] = [SWAP_MAIN_MODEL, SWAP_KLING_MODEL, SWAP_OPENJUTSU_MODEL, SWAP_LONG_MODEL]

/** The models that only swap and always need the tick. */
const ALWAYS_CONSENT = [SWAP_OPENJUTSU_MODEL, SWAP_LONG_MODEL]

/** The steps of the two step swap, as the run names them to the server. */
export type SwapStep = 'frame' | 'video' | 'lipsync'

/** Does the server ask for the tick on this run? SCAIL 2 and Kling also run in
 *  Motion Control (animate), there without. In Swap yes: SCAIL 2 in mode
 *  replace, and every run that names itself a swap step (swap_step), the
 *  frame step with Nano Banana Pro too. The same rule as the web server. */
export function swapConsentRequired(model: string, params: { swap_step?: unknown; studio_options?: unknown }): boolean {
  if (ALWAYS_CONSENT.includes(model)) return true
  if (params.swap_step !== undefined) return true
  const options = params.studio_options as Record<string, unknown> | undefined
  return model === SWAP_MAIN_MODEL && options?.mode === 'replace'
}

export const SWAP_CONSENT_TEXT = 'I have the rights to this video and the consent of the people shown in it and in the photos.'
export const SWAP_CONSENT_MISSING = 'Confirm that you have the rights and the consent of the people shown before you swap them.'

export function swapNeedsConsent(model: string): boolean {
  return SWAP_CONSENT_MODELS.includes(model)
}
