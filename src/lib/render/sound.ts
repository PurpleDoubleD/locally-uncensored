// The sound of a Swap or Motion run (David's wish of 14.11.2026,
// uebergabe-310/CHARACTER-HUB-KONZEPT.md, section "Ton"). Port of the web's
// lib/render/sound.ts (commit 2176d1be).
//
// Three choices, the original sound is the default:
//  * original: the sound of the clip stays. Kling gets keep_original_sound,
//    SCAIL 2 and OpenJutsu pass it through. When an engine returns no sound
//    track (Wan 2.2 Animate is not documented), the server's worker lays the
//    sound of the input clip under it.
//  * none: the result has no sound track. Kling gets keep_original_sound
//    false, otherwise the worker removes the track. Costs nothing.
//  * lipsync: a new voice, the lips follow it. After the video a second run
//    with LatentSync (or Lipsync-2) goes over the result. One person only,
//    cloud only.
//
// Desktop differences: the intent is a plain string (no import of the store,
// which would close a module cycle), and the lip sync price comes from the
// server's catalogue (lengthPrice); a catalogue without the model gives null,
// and the panel then says the step is not available on this LU Cloud.

import { cloudModelById, lengthCredits, lengthPrice } from '../../stores/cloudCatalogStore'
import type { CloudJobSubmit } from '../../api/cloud/jobs'
import { isSwapIntent, swapPricedSeconds } from './swap'

export type SoundChoice = 'original' | 'none' | 'lipsync'

export const SOUND_CHOICES: readonly SoundChoice[] = ['original', 'none', 'lipsync']

export const SOUND_LABEL: Record<SoundChoice, string> = {
  original: 'Original sound',
  none: 'No sound',
  lipsync: 'New voice, lips in sync',
}

/** The models of the lip sync step, the recommended one first. */
export const LIPSYNC_STEP_MODELS: readonly string[] = ['latentsync', 'lipsync-2']
export const LIPSYNC_STEP_DEFAULT = 'latentsync'

export const LIPSYNC_ONE_PERSON = 'Lip sync works with one person'
export const LIPSYNC_CLOUD_ONLY = 'Cloud only'
export const LIPSYNC_NOT_AVAILABLE = 'Lip sync is not available on this LU Cloud'

/** Where the sound choice stands: Swap and Motion, cloud only. */
export function soundApplies(intent: string, backend: string): boolean {
  if (backend !== 'cloud') return false
  return intent === 'motion' || isSwapIntent(intent)
}

/** Why "lipsync" cannot be picked right now, or null. */
export function lipsyncBlocked(people: number, backend: string, model: string = LIPSYNC_STEP_DEFAULT): string | null {
  if (backend !== 'cloud') return LIPSYNC_CLOUD_ONLY
  if (people > 1) return LIPSYNC_ONE_PERSON
  if (!cloudModelById(model)) return LIPSYNC_NOT_AVAILABLE
  return null
}

/** The sound as the video run names it to the server. Lip sync runs after it
 *  as its own step; until then the video run keeps the original sound. */
export function soundParam(sound: SoundChoice): 'original' | 'none' {
  return sound === 'none' ? 'none' : 'original'
}

/** What a model itself knows about sound: Kling has a switch. */
export function soundStudioOptions(model: string, sound: SoundChoice): Record<string, unknown> {
  return model === 'kling-v3-pro-motion-control' ? { keep_original_sound: sound !== 'none' } : {}
}

/** The seconds of voice the lip sync step gets: never longer than the clip
 *  (the server cuts, fit_audio). */
export function lipsyncSeconds(audioSeconds: number | undefined, clipSeconds: number | undefined): number | undefined {
  if (audioSeconds === undefined) return clipSeconds
  if (clipSeconds === undefined) return audioSeconds
  return Math.min(audioSeconds, clipSeconds)
}

/** Is the voice longer than the clip? Then a note says it is cut. */
export function lipsyncCut(audioSeconds: number | undefined, clipSeconds: number | undefined): boolean {
  return audioSeconds !== undefined && clipSeconds !== undefined && audioSeconds > clipSeconds + 0.05
}

/** What the lip sync step costs: the catalogue's price rule (LatentSync by
 *  the length of the voice, at least 3 s; Lipsync-2 by the length of the
 *  clip). null when the server's catalogue does not list the model. */
export function lipsyncCredits(model: string, audioSeconds: number | undefined, clipSeconds: number | undefined): number | null {
  if (!cloudModelById(model)) return null
  const price = lengthPrice(model, 'lipsync')
  if (!price) return lengthCredits(model) || null
  return lengthCredits(model, price.basis === 'audio' ? lipsyncSeconds(audioSeconds, clipSeconds) : clipSeconds)
}

/** Why a run with this sound cannot start, or null. The same sentences as the
 *  web engine (validateCreateJob). */
export function soundInputError(sound: SoundChoice | undefined, people: number, backend: string, hasVoice: boolean, model?: string): string | null {
  if (sound !== 'lipsync') return null
  const blocked = lipsyncBlocked(people, backend, model)
  if (blocked) return `${blocked}. Pick Original sound or remove the other people.`
  if (!hasVoice) return 'Add the new voice: upload audio, make one, or pick an earlier voice.'
  return null
}

/** The body of the lip sync step: the video is the own result of the video
 *  run (adopt), the sound the chosen voice. fit_audio lets the server cut a
 *  longer voice to the length of the clip. In Swap it is a swap step with
 *  the consent tick. */
export function lipsyncSubmit(model: string, videoPath: string, audioPath: string, credits: number | null, swap: boolean): CloudJobSubmit {
  return {
    kind: 'video',
    model,
    prompt: '',
    params: {
      op: 'lipsync',
      video_path: videoPath,
      audio_path: audioPath,
      fit_audio: true,
      ...(credits != null ? { max_credits: credits } : {}),
      label: 'Lip sync',
      ...(swap ? { swap_step: 'lipsync' as const, swap_consent: true } : {}),
    },
  }
}

/** How long the clip is that the lip sync step gets: in Swap the seconds that
 *  run (swapPricedSeconds), in Motion the whole video. */
export function soundClipSeconds(intent: string, model: string, chosen: number | null, videoSeconds: number | undefined): number | undefined {
  if (videoSeconds === undefined) return undefined
  return isSwapIntent(intent) ? swapPricedSeconds(model, chosen, videoSeconds) : videoSeconds
}
