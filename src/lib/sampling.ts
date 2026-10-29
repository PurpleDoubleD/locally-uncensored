import { DEFAULT_SETTINGS } from './constants'
import type { Settings, SamplerValues } from '../types/settings'

/**
 * Sampling for one conversation: temperature, top_p and a max output cap,
 * and since GH #175 the preset a persona carries.
 *
 * R5-10/R5-11 (3.0.1-Liste), the orchestrator's decision on 18.09.2026 (two
 * earlier bauers left this "braucht Entscheid", see bau/w2ui.md; F2, review-
 * w2ui.md: this line previously attributed the decision to the owner, which the
 * 18.09.2026 review found unsupported by any written source and asked to be
 * corrected):
 *
 * 1. The values belong to the CHAT, not to the app. A moved slider applies to
 *    THIS conversation only; a chat that never touched its own slider follows
 *    the Settings page value, and the Settings page keeps setting the
 *    starting point for every new chat, exactly as before.
 *
 * 2. Only a value that differs from the app default goes on the wire. A field
 *    still sitting on the shipped default is left out of the request
 *    entirely, so the model answers at whatever the upstream considers
 *    normal for it instead of at a number LU picked for every model at once.
 *
 * 3. Top K stays a Settings page value for every chat (F3 / R5-13). A
 *    persona may carry its own (GH #175), which then goes on the wire in its
 *    place, together with the other extra samplers the persona set.
 *
 * 4. The order, highest first: this chat's own value, the persona preset of
 *    the speaker (lib/chat-persona.ts), the Settings page, the app default.
 *
 * Mirrors the web app (the 3.0.0 VORBILD) field for field, minus
 * the web-only max-tokens warning copy this popup does not carry.
 */

/** What one conversation overrides, or what a persona carries as its own
 *  preset (GH #175). A key that is absent was never set at that level.
 *
 *  The first three are the ones the per chat popup sets. The others come from
 *  a persona: top K, min P, the repetition, presence and frequency penalties
 *  and the DRY multiplier. Each provider sends only the ones its backend reads
 *  (api/providers/sampler-fields.ts). */
export type SamplingOverrides = SamplerValues

/** The fields as they go into the request options object. */
export type SamplingRequest = SamplingOverrides

/** The three fields every chat has a value for, from the app default up. */
export type CoreSampling = Required<Pick<SamplingOverrides, 'temperature' | 'topP' | 'maxTokens'>>

/** The samplers that only exist where a persona or a chat set them. */
export const EXTRA_SAMPLERS = ['topK', 'minP', 'repeatPenalty', 'presencePenalty', 'frequencyPenalty', 'dryMultiplier'] as const
export type ExtraSampler = (typeof EXTRA_SAMPLERS)[number]

/** Where a field with nothing chosen anywhere sits. Same numbers as
 *  DEFAULT_SETTINGS, named here so the request rule reads as one idea rather
 *  than three lookups. */
export const SAMPLING_DEFAULTS: CoreSampling = {
  temperature: DEFAULT_SETTINGS.temperature,
  topP: DEFAULT_SETTINGS.topP,
  maxTokens: DEFAULT_SETTINGS.maxTokens,
}

/**
 * A33 (3.0.8, Discord "help lol"): the highest temperature LU sends to any
 * backend. The sliders used to run to 2.0, and a customer whose chat sat at
 * 1.9 got nothing but mixed-language noise from every model, local and cloud,
 * while one cloud backend refused the request outright (it takes 0 to 1).
 * Above about 1.5 no model writes readable text, so a higher number is never
 * a style choice, only a broken chat.
 */
export const TEMPERATURE_MAX = 1.5

/** From here on the controls warn that the answer turns into random text. */
export const TEMPERATURE_WARN = 1.2

/** The one sentence every warning shows, in the Settings page, the chat
 *  popup and the persona editor alike. */
export const HIGH_TEMPERATURE_WARNING = 'High values make the model produce random text.'

/**
 * What the temperature slider does, behind the "?" next to it, in the chat
 * popup, the Settings page and the persona editor. The warning above only
 * speaks once the value is high; this says what the slider is for before
 * anyone gets there (David, 27.10.2026). The web app shows the same words,
 * and a test on each side pins them.
 */
export const TEMPERATURE_HELP =
  'Temperature controls how random the answers are. Low (0.2 to 0.5): focused and repeatable. '
  + 'Around 0.7: balanced, the default. Above 1.2: answers can turn into random text.'
/** Accessible name of the "?" button. */
export const TEMPERATURE_HELP_LABEL = 'What temperature does'

/**
 * The most Agent turns use, whatever the chat, the persona or the Settings
 * page say. A tool call is a JSON object that must parse; a run of them at
 * a creative temperature breaks long before plain chat does.
 */
export const AGENT_TEMPERATURE_MAX = 1.0

/**
 * The temperature an Agent turn sends (A33). Small-Model Mode keeps its own
 * low cap (Knob 6, never raises). Otherwise the chat's value goes out as in
 * plain chat, held at AGENT_TEMPERATURE_MAX; a field left at the default stays
 * off the wire, so the backend still picks its own.
 */
export function agentTemperature(
  effective: number,
  sent: number | undefined,
  smallModelMode: boolean,
): number | undefined {
  if (smallModelMode) return Math.min(effective, 0.3)
  if (sent === undefined) return undefined
  return Math.min(sent, AGENT_TEMPERATURE_MAX)
}

/** The top P a temperature above 1 goes out with when nothing else holds the
 *  tail back. Same number as the app default. */
export const HIGH_TEMPERATURE_TOP_P = 0.9

/**
 * The top P an OpenAI compatible request carries (A33). Above temperature 1
 * the long tail of unlikely tokens gets enough weight to take over, and a
 * backend that applies no top K of its own (LU Cloud gets none from us, most
 * hosted APIs default to top P 1.0) then writes noise: measured on Qwen 3.5
 * 9B with nothing cut off, 1.2 still reads, 1.3 slips, 1.5 is gibberish; with
 * top P 0.9, 1.5 reads. So a top P that is missing or wider than 0.9 is
 * narrowed to 0.9 there, and left alone at 1 and below.
 */
export function topPForTemperature(temperature: number | undefined, topP: number | undefined): number | undefined {
  if (temperature === undefined || temperature <= 1) return topP
  return topP === undefined ? HIGH_TEMPERATURE_TOP_P : Math.min(topP, HIGH_TEMPERATURE_TOP_P)
}

/** Whether a temperature is high enough for the warning. */
export function isHighTemperature(value: number | undefined): boolean {
  return typeof value === 'number' && value >= TEMPERATURE_WARN
}

/**
 * A stored temperature as the request may carry it: a finite number within
 * 0..TEMPERATURE_MAX, or undefined for anything else. Used on load (A33): a
 * value above the limit was written by a build whose slider ran to 2.0, and
 * it goes, so the field falls back to the next level and finally the
 * default, instead of being pinned to the ceiling.
 */
export function storedTemperature(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0 || value > TEMPERATURE_MAX) return undefined
  return value
}

const BOUNDS: Record<keyof SamplingOverrides, [number, number]> = {
  temperature: [0, TEMPERATURE_MAX],
  topP: [0, 1],
  // A cap above any context window served is the same as no cap; the ceiling
  // here only stops a hand-edited store from putting nonsense on the wire.
  maxTokens: [0, 1_000_000],
  topK: [0, 1000],
  minP: [0, 1],
  repeatPenalty: [0, 2],
  // The range of the OpenAI spec, which Ollama and llama-server share.
  presencePenalty: [-2, 2],
  frequencyPenalty: [-2, 2],
  dryMultiplier: [0, 5],
}

/** Hold a written value inside its field's range and drop anything that is
 *  not a finite number. The store calls this on every write, so a persisted
 *  record can only ever hold values the request builder is allowed to
 *  forward. */
export function clampSampling(patch: SamplingOverrides): SamplingOverrides {
  const out: SamplingOverrides = {}
  for (const key of Object.keys(BOUNDS) as (keyof SamplingOverrides)[]) {
    const value = patch[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const [min, max] = BOUNDS[key]
    out[key] = Math.min(max, Math.max(min, value))
  }
  return out
}

/**
 * The value the control shows for each field: what this chat chose, else the
 * persona preset (GH #175), else the global setting, else the app default.
 * Always three numbers, because a slider needs a position even for a field
 * nobody has touched.
 */
export function effectiveSampling(
  settings: Pick<Settings, 'temperature' | 'topP' | 'maxTokens'>,
  overrides?: SamplingOverrides,
  preset?: SamplingOverrides,
): CoreSampling {
  // Clamped here as well as on every write and on load (A33), so a value
  // that reached a store by any other way still never leaves the app above
  // the limit.
  const temperature = overrides?.temperature ?? preset?.temperature ?? settings.temperature ?? SAMPLING_DEFAULTS.temperature
  return {
    temperature: Number.isFinite(temperature) ? Math.min(TEMPERATURE_MAX, Math.max(0, temperature)) : SAMPLING_DEFAULTS.temperature,
    topP: overrides?.topP ?? preset?.topP ?? settings.topP ?? SAMPLING_DEFAULTS.topP,
    maxTokens: overrides?.maxTokens ?? preset?.maxTokens ?? settings.maxTokens ?? SAMPLING_DEFAULTS.maxTokens,
  }
}

/** The extra samplers in force: the chat's own value, else the persona's. */
export function effectiveExtraSamplers(overrides?: SamplingOverrides, preset?: SamplingOverrides): SamplingOverrides {
  const out: SamplingOverrides = {}
  for (const key of EXTRA_SAMPLERS) {
    const value = overrides?.[key] ?? preset?.[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * What this turn puts in the request options, and nothing more.
 *
 * A field whose effective value is still the app default is omitted, so the
 * provider never serialises it and the upstream applies its own default. A
 * field the user moved, in this chat, in the persona or on the Settings page,
 * is present with that number. Max tokens counts 0 as "auto", which is both
 * the app default and the absence of a cap, so it is omitted the same way.
 * The extra samplers have no app default at all: they are present exactly
 * when the chat or the persona set them.
 */
export function buildSamplingRequest(
  settings: Pick<Settings, 'temperature' | 'topP' | 'maxTokens'>,
  overrides?: SamplingOverrides,
  preset?: SamplingOverrides,
): SamplingRequest {
  const value = effectiveSampling(settings, overrides, preset)
  const request: SamplingRequest = {}
  if (value.temperature !== SAMPLING_DEFAULTS.temperature) request.temperature = value.temperature
  if (value.topP !== SAMPLING_DEFAULTS.topP) request.topP = value.topP
  if (value.maxTokens > 0) request.maxTokens = value.maxTokens
  return { ...request, ...effectiveExtraSamplers(overrides, preset) }
}

/**
 * Whether this chat sends any sampling value at all. Drives the quiet marker
 * on the closed control: the marker means exactly one thing, something about
 * this chat is on the wire, whether that value came from this chat's own
 * override or from the Settings page differing from the shipped default.
 *
 * NOT the right check for whether Reset can do anything (see
 * `hasOwnSampling` below): a chat that never touched its own slider can
 * still show this as true purely because the Settings page moved, and Reset
 * has nothing of this chat's own to delete in that case.
 */
export function samplingIsChanged(
  settings: Pick<Settings, 'temperature' | 'topP' | 'maxTokens'>,
  overrides?: SamplingOverrides,
  preset?: SamplingOverrides,
): boolean {
  return Object.keys(buildSamplingRequest(settings, overrides, preset)).length > 0
}

/**
 * F1 (review-w2ui.md, 18.09.2026): whether THIS conversation has its own
 * sampling value at all, i.e. whether `resetConversationSampling` has
 * anything to delete. `samplingIsChanged` answers a different question (is
 * anything non-default on the wire, from EITHER source) and used to also
 * gate the Reset button: a chat that never moved its own slider, on a
 * Settings page that had moved, showed Reset as enabled and clicking it
 * deleted a field (`sampling`) that did not exist, doing nothing.
 */
export function hasOwnSampling(overrides?: SamplingOverrides): boolean {
  return !!overrides && Object.keys(overrides).length > 0
}
