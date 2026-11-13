/**
 * What the stage of Create shows, as a small state machine. Pure.
 *
 * The cloud hook writes loose facts into the create store (running or not, a
 * percent, a sentence, an error). The page needs one answer: which of its
 * faces is on screen, and what the main button does. This file turns the
 * facts into that answer, and every edge is written down once.
 */
import type { ToolId } from './tools'

export type RunView =
  /** Nothing ran yet for this tool: the empty state with examples. */
  | 'empty'
  /** A run is on its way. */
  | 'running'
  /** The last run left a result. */
  | 'result'
  /** The last run ended with an error and nothing to show. */
  | 'failed'

export interface RunState {
  view: RunView
  tool: ToolId
  /** Gallery id of the result on the stage. */
  resultId: string | null
  /** More results of the same run (several images), newest first, including resultId. */
  resultIds: string[]
  /** When the run started, for the clock. */
  startedAt: number | null
  /** The error of the last run, as the store said it. */
  error: string | null
  /** The user asked to cancel and the answer is not in yet. */
  cancelling: boolean
}

export type RunEvent =
  | { type: 'tool'; tool: ToolId }
  | { type: 'start'; at: number }
  | { type: 'landed'; id: string }
  | { type: 'error'; message: string }
  | { type: 'cancel' }
  /** The hook let go of the run (finished, failed, cancelled). */
  | { type: 'end' }
  | { type: 'show'; id: string }
  | { type: 'dismiss-error' }
  | { type: 'removed'; id: string }

export function initialRun(tool: ToolId): RunState {
  return { view: 'empty', tool, resultId: null, resultIds: [], startedAt: null, error: null, cancelling: false }
}

export function runReducer(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case 'tool':
      // Another tool starts clean. A run in flight keeps its face: it belongs to the tool it started in.
      if (event.tool === state.tool) return state
      if (state.view === 'running') return { ...state, tool: event.tool }
      return initialRun(event.tool)
    case 'start':
      return { ...state, view: 'running', startedAt: event.at, error: null, cancelling: false, resultId: null, resultIds: [] }
    case 'landed': {
      if (state.resultIds.includes(event.id)) return state
      const resultIds = [event.id, ...state.resultIds]
      // While the run goes on (several images) the stage keeps the waiting face and collects.
      return { ...state, resultIds, resultId: state.resultId ?? event.id, view: state.view === 'running' ? 'running' : 'result' }
    }
    case 'error':
      return { ...state, error: event.message }
    case 'cancel':
      return state.view === 'running' ? { ...state, cancelling: true } : state
    case 'end': {
      if (state.view !== 'running') return state
      const base = { ...state, cancelling: false, startedAt: null }
      if (state.resultIds.length > 0) return { ...base, view: 'result', resultId: state.resultIds[state.resultIds.length - 1] }
      if (state.error) return { ...base, view: 'failed' }
      return { ...base, view: 'empty' }
    }
    case 'show':
      if (state.view === 'running') return state
      return { ...state, view: 'result', resultId: event.id, resultIds: state.resultIds.includes(event.id) ? state.resultIds : [event.id], error: null }
    case 'dismiss-error':
      if (state.view === 'failed') return { ...state, view: 'empty', error: null }
      return { ...state, error: null }
    case 'removed': {
      if (!state.resultIds.includes(event.id)) return state
      const resultIds = state.resultIds.filter((id) => id !== event.id)
      if (state.view !== 'result') return { ...state, resultIds, resultId: state.resultId === event.id ? resultIds[0] ?? null : state.resultId }
      if (resultIds.length === 0) return { ...state, view: 'empty', resultId: null, resultIds }
      return { ...state, resultIds, resultId: state.resultId === event.id ? resultIds[0] : state.resultId }
    }
  }
}

// ---------- the phase of a running job ----------

export type RunPhase = 'uploading' | 'improving' | 'pricing' | 'submitting' | 'queued' | 'rendering' | 'finishing'

/** The phase, read from what the cloud hook reports. `text` is its English progress sentence. */
export function runPhase(facts: { progress: number; phase: string; text: string }): RunPhase {
  const text = facts.text.toLowerCase()
  if (facts.phase === 'complete' || facts.progress >= 100) return 'finishing'
  if (facts.phase === 'sampling') return 'rendering'
  if (text.includes('upload') || text.includes('fetching')) return 'uploading'
  if (text.includes('improv') || text.includes('rewrit')) return 'improving'
  if (text.includes('price')) return 'pricing'
  if (text.includes('submitting')) return 'submitting'
  if (text.includes('waiting')) return 'queued'
  if (facts.progress >= 15) return 'queued'
  return 'uploading'
}

/** The share for the bar, 0 to 1. Before the job is accepted there is no honest number. */
export function runShare(facts: { progress: number; phase: string }): number | undefined {
  if (facts.progress <= 0) return undefined
  return Math.min(1, Math.max(0.02, facts.progress / 100))
}

/** "3/8" from "Uploading photos… 3/8", else null. */
export function uploadCount(text: string): { done: number; total: number } | null {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text)
  if (!m) return null
  const done = Number(m[1])
  const total = Number(m[2])
  return total > 0 && done <= total ? { done, total } : null
}

// ---------- may the run start ----------

export type BlockReason =
  | 'offline'
  | 'no-prompt'
  | 'no-source'
  | 'no-mask'
  | 'no-character'
  | 'no-photos'
  | 'no-voice'
  | 'no-portrait'
  | 'no-clip'
  | 'no-motion-video'
  /** 3D from a video: no video read yet. */
  | 'no-3d-video'
  | 'no-model'
  | 'price-unavailable'
  | 'price-measuring'
  | 'quota-unknown'

export interface ReadyInput {
  online: boolean
  tool: ToolId
  promptNeeded: boolean
  prompt: string
  sourceNeeded: boolean
  hasSource: boolean
  maskNeeded: boolean
  hasMask: boolean
  /** Character tool. */
  characterUse: boolean
  hasCharacter: boolean
  trainPhotos: number
  minTrainPhotos: number
  /** Talking. */
  hasVoice: boolean
  needsPortrait: boolean
  needsClip: boolean
  hasVideo: boolean
  /** Extend. */
  hasExtendClip: boolean
  /** 3D: the way of the tool. Its source is a still frame on the video way. */
  threeDWay?: 'text' | 'image' | 'video'
  hasModel: boolean
  /** A model whose price the server confirms. */
  /** pending only changes the label, the server confirms again at the start. */
  priceState: 'known' | 'pending' | 'measuring' | 'unavailable'
  quotaKnown: boolean
}

/** The first thing that keeps the run from starting, or null. Credits are not here: an empty wallet opens its own sheet. */
export function blockReason(i: ReadyInput): BlockReason | null {
  if (!i.online) return 'offline'
  if (!i.hasModel) return 'no-model'
  if (i.tool === 'character') {
    if (i.characterUse) {
      if (!i.hasCharacter) return 'no-character'
    } else if (i.trainPhotos < i.minTrainPhotos) return 'no-photos'
  }
  if (i.tool === 'lipsync') {
    if (i.needsClip && !i.hasVideo) return 'no-clip'
    if (i.needsPortrait && !i.hasSource) return 'no-portrait'
    if (!i.hasVoice) return 'no-voice'
  }
  if (i.tool === 'extend' && !i.hasExtendClip) return 'no-clip'
  if (i.tool === 'motion') {
    if (!i.hasSource) return 'no-portrait'
    if (!i.hasVideo) return 'no-motion-video'
  }
  if (i.tool === '3d' && i.threeDWay === 'video' && !i.hasSource) return 'no-3d-video'
  if (i.sourceNeeded && !i.hasSource) return 'no-source'
  if (i.maskNeeded && !i.hasMask) return 'no-mask'
  if (i.promptNeeded && i.prompt.trim().length === 0) return 'no-prompt'
  if (i.priceState === 'unavailable') return 'price-unavailable'
  // The price of this run depends on a length that is still being measured: no tap before the number is right.
  if (i.priceState === 'measuring') return 'price-measuring'
  if (!i.quotaKnown) return 'quota-unknown'
  return null
}

/** What the wallet says to a price. */
export type WalletVerdict = 'ok' | 'credits' | 'video_budget' | 'trainings'

export function walletVerdict(meter: 'ok' | 'insufficient' | 'no-trainings' | 'no-video-budget'): WalletVerdict {
  if (meter === 'insufficient') return 'credits'
  if (meter === 'no-trainings') return 'trainings'
  if (meter === 'no-video-budget') return 'video_budget'
  return 'ok'
}
