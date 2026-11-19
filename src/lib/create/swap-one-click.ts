// The picks of the one click swap (14.11.2026, only with the account switch;
// port of the web's lib/create/swap-one-click.ts): which editor builds the
// first frame and which engine makes the video. The editor follows the
// switch "Uncensored"; the engine is SCAIL-2 until the customer picks another
// one. Since 19.11.2026 it no longer follows the number of people by itself
// (4 people: OpenJutsu is recommended at Create, picked by a click).
// Without React; the panel (hub/SwapOneClick.tsx) only holds the state.

import { create } from 'zustand'
import { STUDIO_MODELS } from '../render/studio-contract'
import {
  SWAP_DEFAULT_MODEL, swapFrameEditors, swapFrameModelFor, swapMaxPeople, swapUsesFrame,
  SWAP_FRAME_MODEL, SWAP_FRAME_OPEN_MODEL, SWAP_INTENT, SWAP_KLING_MODEL, SWAP_LONG_MODEL, SWAP_MAIN_MODEL, SWAP_OPENJUTSU_MODEL,
} from '../render/swap'

/** The engines "Video ▾" offers. */
export const SWAP_VIDEO_CHOICES: readonly string[] = [SWAP_MAIN_MODEL, SWAP_KLING_MODEL, SWAP_OPENJUTSU_MODEL, SWAP_LONG_MODEL]

/** The engine of the video: the own pick, else SCAIL-2. Never switched by
 *  the number of people (no silent switch, David 19.11.2026); more people
 *  than the engine takes block Create with a recommendation instead. */
export function swapVideoModelFor(_people: number, override: string | null): string {
  if (override && SWAP_VIDEO_CHOICES.includes(override)) return override
  return SWAP_DEFAULT_MODEL
}

/** Why an engine cannot take this many people, or null. */
export function swapVideoBlocked(model: string, people: number): string | null {
  const max = swapMaxPeople(model)
  if (Math.max(1, people) <= max) return null
  return max === 1 ? 'one person only' : `up to ${max} people`
}

/** Does the swap run on this engine as a chain (frame, then video)? */
export function swapIsChain(videoModel: string): boolean {
  return swapUsesFrame(SWAP_INTENT, videoModel)
}

/** The name of a model as the bar shows it ("SCAIL-2", "Nano Banana Pro"). */
export function swapModelName(id: string): string {
  if (id === SWAP_MAIN_MODEL) return 'SCAIL-2'
  if (id === SWAP_KLING_MODEL) return 'Kling 3.0 Pro'
  return STUDIO_MODELS[id]?.label ?? id
}

/** The grey line under "Uncensored": what runs with and without the switch. */
export function swapOpenModelsLine(videoModel: string): string {
  return `Off: ${swapModelName(SWAP_FRAME_MODEL)} + ${swapModelName(videoModel)}. On: open-weight models, less strict.`
}

/** The picks of "First frame ▾": Auto and every editor that reads two images. */
export function swapFrameChoices(openModels: boolean): { value: string; label: string }[] {
  const auto = swapFrameModelFor(openModels, null)
  return [
    { value: '', label: `Auto (${swapModelName(auto)})` },
    ...swapFrameEditors().map((id) => ({ value: id, label: swapModelName(id) })),
  ]
}

export interface SwapOneClickPrefs {
  /** The switch "Uncensored" (on the web "Open models"). */
  openModels: boolean
  check: boolean
  /** The customer set "Check first frame" by hand: from then on it no longer
   *  follows "Uncensored". */
  checkTouched: boolean
  /** Editor under More options, '' = Auto. */
  frameOverride: string
  /** Engine under More options, '' = Auto. */
  videoOverride: string
  setOpenModels: (v: boolean) => void
  /** The customer's own pick of "Check first frame". */
  setCheck: (v: boolean) => void
  setFrameOverride: (v: string) => void
  setVideoOverride: (v: string) => void
}

/** "Check first frame" by default: on with "Uncensored", off without it
 *  (David's call, 14.11.2026: the open editor is less sure, the customer
 *  sees its frame before paying for the video). */
export function swapCheckDefault(openModels: boolean): boolean {
  return openModels
}

/** Both switches start off (David's call). Turning "Uncensored" on or off
 *  takes "Check first frame" along to its default, unless the customer set
 *  that switch by hand. */
export const useSwapOneClick = create<SwapOneClickPrefs>((set) => ({
  openModels: false,
  check: swapCheckDefault(false),
  checkTouched: false,
  frameOverride: '',
  videoOverride: '',
  setOpenModels: (openModels) => set((s) => (s.checkTouched ? { openModels } : { openModels, check: swapCheckDefault(openModels) })),
  setCheck: (check) => set({ check, checkTouched: true }),
  setFrameOverride: (frameOverride) => set({ frameOverride }),
  setVideoOverride: (videoOverride) => set({ videoOverride }),
}))

export { SWAP_FRAME_MODEL, SWAP_FRAME_OPEN_MODEL }
