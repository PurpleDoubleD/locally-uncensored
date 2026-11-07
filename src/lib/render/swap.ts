// Swap Character: a real video stays as it is (motion, camera, sound, scene),
// and the people in it become the people of the customer's photos.
//
// Port of the web app's lib/render/swap.ts (07.11.2026, C52), cut to the one
// mode the desktop offers. The web also has Swap Scene and Swap Both; the
// desktop does not, so only the rules of Swap Character are here. The names,
// numbers and sentences are the web's, so a run from either app books and
// reads the same.
//
// Models, the recommended first:
//   openjutsu-character-swap  1 to 4 people, one photo each and an optional
//                             role per photo, sound and scene kept, at most
//                             the first 15 seconds of the video.
//   wan-2.2-animate-replace   one person, up to 120 seconds, always mode
//                             replace.
//   scail-2                   one person, mode replace, chosen by hand only.

import { STUDIO_MODELS, studioSchema } from './studio-contract'

export const SWAP_INTENT = 'swap_character' as const
export type SwapIntent = typeof SWAP_INTENT

export function isSwapIntent(intent: string): intent is SwapIntent {
  return intent === SWAP_INTENT
}

/** The models of Swap Character, the recommended first. */
export const SWAP_MODELS: readonly string[] = ['openjutsu-character-swap', 'wan-2.2-animate-replace', 'scail-2']

/** The main model, and the one for videos longer than it reads. */
export const SWAP_MAIN_MODEL = 'openjutsu-character-swap'
export const SWAP_LONG_MODEL = 'wan-2.2-animate-replace'

/** What the mode fixes and the customer therefore never sees. SCAIL 2 and
 *  Wan 2.2 Animate run as replace here: as animate they would put the new
 *  person in front of a new background, which is Motion Control. */
export function swapFixedOptions(intent: string, model: string): Record<string, unknown> {
  if (isSwapIntent(intent) && (model === 'scail-2' || model === SWAP_LONG_MODEL)) return { mode: 'replace' }
  return {}
}

/** Fields the Swap panel shows itself (a role per person, the resolution) and
 *  the settings drawer therefore leaves out. `mode` is fixed (above). */
export function swapPanelFields(intent: string): string[] {
  return isSwapIntent(intent) ? ['roles', 'resolution', 'mode'] : []
}

/** How many people a model swaps in one run. */
export function swapMaxPeople(model: string): number {
  return model === SWAP_MAIN_MODEL ? 4 : 1
}

/** Does the model read one role per photo (`roles`)? */
export function swapReadsRoles(model: string): boolean {
  return !!STUDIO_MODELS[model] && 'roles' in (studioSchema(model).properties ?? {})
}

/** The model Swap Character picks for this length and this many people: up to
 *  15 s the main model, longer Wan 2.2 Animate. Several people only the main
 *  model can do; then it stays, and the first 15 s run. */
export function swapAutoModel(seconds: number | undefined, figures: number): string {
  if (figures > 1) return SWAP_MAIN_MODEL
  return seconds !== undefined && seconds > swapClipLimits(SWAP_MAIN_MODEL).max ? SWAP_LONG_MODEL : SWAP_MAIN_MODEL
}

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

/** The limits of a model, from the catalogue (studio-models.json). The main
 *  model needs at least 2 seconds of video (its model page). */
export function swapClipLimits(model: string): SwapClipLimits {
  const price = STUDIO_MODELS[model]?.price
  const max = price?.maxSeconds ?? 120
  const billedMin = price?.minSeconds ?? 3
  const min = model === SWAP_MAIN_MODEL ? 2 : 1
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
 *  The slider, the Create button and the server count the same. */
export function swapPricedSeconds(model: string, chosen: number | null, videoSeconds: number): number {
  const { max } = swapClipLimits(model)
  return Math.min(videoSeconds, chosen ?? max, max)
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

/** The roles as the provider gets them, or undefined. One photo without a role
 *  replaces the most prominent person. Once one role is set every photo needs
 *  one, or a role would land on the wrong photo; an empty role therefore gets
 *  its place from the left. */
export function swapRoles(figures: SwapFigureSpec[]): string[] | undefined {
  const roles = figures.map((f) => f.role.trim().slice(0, 200))
  if (roles.every((r) => !r)) return undefined
  return roles.map((r, i) => r || `the ${ORDINAL[i] ?? `${i + 1}th`} person from the left`)
}

/** What stands in the panel before the start (from the test runs of
 *  06.11.2026), so it is not learned from a failed run. */
export const SWAP_TIPS = [
  'People only: animals are refused, or turned into a person.',
  'One continuous shot, no hard cuts. The person must be visible in the first frame.',
] as const

/** The heading of a result in the gallery. */
export const SWAP_GALLERY_LABEL = 'Swap Character'

// Consent (07.11.2026, as on the web). The server refuses a run of these
// models without params.swap_consent === true (400, code
// swap_consent_required). The panel shows the box only for them, and Create
// waits for the tick. The tick is runtime only and never stored.

/** The models whose run needs the customer's confirmation. */
export const SWAP_CONSENT_MODELS: readonly string[] = [SWAP_MAIN_MODEL, SWAP_LONG_MODEL]

export const SWAP_CONSENT_TEXT = 'I have the rights to this video and the consent of the people shown in it and in the photos.'
export const SWAP_CONSENT_MISSING = 'Confirm that you have the rights and the consent of the people shown before you swap them.'

export function swapNeedsConsent(model: string): boolean {
  return SWAP_CONSENT_MODELS.includes(model)
}
