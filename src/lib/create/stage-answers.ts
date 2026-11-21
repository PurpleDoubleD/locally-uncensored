/**
 * What the Create stage may show while an answer about the tab is still out.
 *
 * The stage asks ComfyUI, the disk and the local engines whether a tab can
 * run. Those answers take a moment, and "not answered yet" used to be drawn
 * like "ready" or like "missing": the work surface came first and the setup
 * card a second later, or the card said "needs a download" and then "your
 * files are already here" (measured 21.11.2026, 44 such changes in 184 tab
 * switches with answers delayed by 800 ms).
 *
 * The rule: while the answer is out, the stage shows the last answer it knows
 * for this tab, or a quiet waiting face when it knows none. A new answer
 * always wins, so a model that was installed or deleted still arrives.
 *
 * Pure apart from the small book of answers, which outlives the Create view
 * because leaving Create unmounts everything that asked.
 */

/** One question about a tab: must it set something up, or is it ready. */
export type StageAnswer = 'setup' | 'ready' | 'unknown'

/** What the stage of a tab shows. */
export type LaneFace = 'wait' | 'models' | 'capability' | 'work'

/** The longest the stage waits before it falls back to the work surface, so
 *  a backend that never answers cannot leave it empty. Longer than the
 *  startup retries of the model list (12 rounds of 3 s). */
export const STAGE_WAIT_MAX_MS = 60_000

export interface CapabilityInput {
  /** The tab needs a node pack at all, on this backend and host. */
  needed: boolean
  /** The node pack was seen. */
  present: boolean
  connected: boolean | null
  /** null until the first look at the ComfyUI process came back. */
  comfyStarting?: boolean | null
  /** ComfyUI answers, its node list is still on the way. */
  capsPending?: boolean
}

/** Whether the node pack of a tab is missing. Only a ComfyUI that answered
 *  can say so, or one that is known not to be coming up. */
export function capabilityAnswer(i: CapabilityInput): StageAnswer {
  if (!i.needed || i.present) return 'ready'
  if (i.connected === null) return 'unknown'
  if (i.connected === false) return i.comfyStarting === null || i.comfyStarting === true ? 'unknown' : 'setup'
  return i.capsPending ? 'unknown' : 'setup'
}

/** The face from the two questions, in the order the stage asks them. */
export function laneFace(models: StageAnswer, capability: StageAnswer): LaneFace {
  if (models === 'setup') return 'models'
  if (models === 'unknown') return 'wait'
  if (capability === 'setup') return 'capability'
  return capability === 'unknown' ? 'wait' : 'work'
}

/** A live answer wins. Without one, the last known face stands. */
export function settleFace(live: LaneFace, remembered: LaneFace | undefined): LaneFace {
  return live === 'wait' ? remembered ?? 'wait' : live
}

export interface ThreeDFaceInput {
  /** null while the engine check is out. */
  ready: boolean | null
  /** A Mac asks its own engine and does not depend on ComfyUI. */
  mac: boolean
  connected: boolean | null
  comfyStarting?: boolean | null
}

/** The 3D tab has its own setup card. A PC whose ComfyUI may still be coming
 *  up has not said that the files are missing. */
export function threeDFace(i: ThreeDFaceInput): 'wait' | 'setup' | 'work' {
  if (i.ready === null) return 'wait'
  if (i.ready) return 'work'
  if (!i.mac && (i.connected === null || (i.connected === false && (i.comfyStarting === null || i.comfyStarting === true)))) return 'wait'
  return 'setup'
}

export interface AnswerBook {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  /** Take before asking, hand back with the answer. */
  ticket(): number
  /** Keeps the answer unless the book was cleared since the ticket: a reply
   *  asked before a model change says nothing about the state after it. */
  answer(key: string, value: unknown, ticket: number): boolean
  clear(): void
}

export function createAnswerBook(): AnswerBook {
  const answers = new Map<string, unknown>()
  let epoch = 0
  return {
    get: <T,>(key: string) => answers.get(key) as T | undefined,
    set: (key, value) => { answers.set(key, value) },
    ticket: () => epoch,
    answer: (key, value, ticket) => {
      if (ticket !== epoch) return false
      answers.set(key, value)
      return true
    },
    clear: () => { epoch++; answers.clear() },
  }
}

/** The answers of this session, per tab and model state. */
export const stageAnswers = createAnswerBook()

// A model came or went, wherever in the app that happened: what the book says
// about any tab is no longer known.
if (typeof window !== 'undefined') {
  const forget = () => stageAnswers.clear()
  window.addEventListener('comfyui-model-downloaded', forget)
  window.addEventListener('lu-models-refresh', forget)
}
