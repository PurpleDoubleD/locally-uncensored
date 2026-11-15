// Local 3D on Windows and Linux (3.1.0): one picture in, one GLB out, through
// the TRELLIS.2 core nodes of the pinned ComfyUI (v0.42.4). The Mac has no
// ComfyUI and runs its own engine (api/mlx-3d.ts).
//
// Two calls for Create:
//   comfyThreeDReady()  are all five files of the bundle in ComfyUI's lists
//   runComfyThreeD()    queue the graph, follow it, hand back the saved file
//
// The graph is buildThreeDWorkflow (api/dynamic-workflow.ts), where its source
// is written down. The phase words are the Mac's (lib/mac-3d.ts), so both
// platforms say the same thing at the same point.

import {
  COMFY_MODEL_FOLDERS, abandonPrompt, extractComfyOutputFiles, getHistory, promptQueueState, submitWorkflow,
  type ComfyUIOutput,
} from '../api/comfyui'
import { CLIENT_ID, comfyWS, type ComfyWSEvent } from '../api/comfyui-ws'
import {
  THREE_D_SAVE_NODE, buildLocalThreeDWorkflow, type ThreeDDetail,
} from '../api/dynamic-workflow'
import { getThreeDBundles } from '../api/model-bundles'
import type { ComfyApiGraph, ComfyHistoryEntry } from '../types/comfy-graph'
import { MESH3D_PHASE_TEXT, type Mesh3dPhase } from './mac-3d'
import { resolveRunSeed } from './run-seed'

export type { ThreeDDetail } from '../api/dynamic-workflow'

const MESH_EXT = /\.(glb|gltf|obj|ply|stl)$/i

function baseName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).toLowerCase()
}

/**
 * Whether ComfyUI lists every file of the 3D bundle, each in the folder the
 * bundle puts it in. False when ComfyUI cannot be asked, or when a folder's
 * loader is not registered (a ComfyUI older than the lane), so the setup card
 * shows instead of a run that fails on its first node.
 */
export async function comfyThreeDReady(): Promise<boolean> {
  const [bundle] = getThreeDBundles()
  if (!bundle) return false
  const wanted = bundle.files.filter((f) => f.filename && f.subfolder)
  const folders = [...new Set(wanted.map((f) => f.subfolder!))]
  try {
    const lists = await Promise.all(folders.map(async (sub) => {
      const entry = COMFY_MODEL_FOLDERS.find((f) => f.subfolder === sub)
      const names = entry ? await entry.read() : null
      return [sub, names ? new Set(names.map(baseName)) : null] as const
    }))
    const bySub = new Map(lists)
    return wanted.every((f) => bySub.get(f.subfolder!)?.has(f.filename!.toLowerCase()) ?? false)
  } catch {
    return false
  }
}

export interface RunComfyThreeDOptions {
  /** The picture, already uploaded to ComfyUI's input folder (ImageRef.filename). */
  imageName: string
  detail: ThreeDDetail
  cutout: boolean
  seed?: number
  signal?: AbortSignal
  onProgress?: (line: string, percent?: number) => void
}

/** The phase a node of the 3D graph belongs to, by the graph's node id (the
 *  template's ids, see buildThreeDWorkflow). Ids not named here are loaders
 *  and model patches, which belong to getting the model ready. */
const PHASE_BY_NODE: Record<string, Mesh3dPhase> = {
  '193': 'cutout', '192': 'cutout', '312': 'cutout',
  '299': 'shape', '87': 'shape', '3': 'shape', '119': 'shape', '91': 'shape', '18': 'shape',
  '94': 'shape', '23': 'shape', '92': 'shape', '241': 'shape', '186': 'shape', '238': 'shape',
  '98': 'paint', '12': 'paint', '93': 'paint', '196': 'paint', '147': 'paint', '224': 'paint',
  '233': 'paint', '210': 'paint',
  '260': 'save', [THREE_D_SAVE_NODE]: 'save',
}
const PHASE_ORDER: Mesh3dPhase[] = ['load', 'cutout', 'shape', 'paint', 'save']

/** The phase of one node. Without a cutout the crop is part of getting ready. */
export function threeDPhaseForNode(nodeId: string, cutout: boolean): Mesh3dPhase {
  const phase = PHASE_BY_NODE[nodeId] ?? 'load'
  return phase === 'cutout' && !cutout ? 'load' : phase
}

/** Follows one run: which nodes are done, which one runs and how far its
 *  sampler is. The line only moves forward, because ComfyUI does not run the
 *  graph in the order a person reads it. Pure, so it is under test. */
export function createThreeDProgress(graph: ComfyApiGraph, cutout: boolean) {
  const total = Math.max(1, Object.keys(graph).length)
  const done = new Set<string>()
  let current: string | null = null
  let fraction = 0
  let phase: Mesh3dPhase = 'load'
  let percent = 0
  const advance = (p: Mesh3dPhase) => {
    if (PHASE_ORDER.indexOf(p) > PHASE_ORDER.indexOf(phase)) phase = p
  }
  const report = () => {
    const raw = Math.round((100 * (done.size + fraction)) / total)
    percent = Math.min(99, Math.max(percent, raw))
    return { line: MESH3D_PHASE_TEXT[phase], percent }
  }
  return {
    executing(node: string | null) {
      if (current) done.add(current)
      current = node && node in graph ? node : null
      fraction = 0
      if (current) advance(threeDPhaseForNode(current, cutout))
      return report()
    },
    cached(nodes: string[]) {
      for (const n of nodes) if (n in graph) done.add(n)
      return report()
    },
    step(value: number, max: number) {
      fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
      return report()
    },
    get phase() { return phase },
  }
}

/** The saved model in a finished run's history: the save node's file first,
 *  any mesh file of any node after it. Null when there is none. */
export function threeDOutputFromHistory(history: ComfyHistoryEntry | null): ComfyUIOutput | null {
  const outputs = history?.outputs ?? {}
  const ids = [THREE_D_SAVE_NODE, ...Object.keys(outputs).filter((k) => k !== THREE_D_SAVE_NODE)]
  for (const id of ids) {
    const file = extractComfyOutputFiles(outputs[id]).find((f) => MESH_EXT.test(f.filename))
    if (file) return file
  }
  return null
}

function historyError(history: ComfyHistoryEntry): string {
  const messages = Array.isArray(history.status?.messages) ? history.status!.messages! : []
  const err = messages.find(([t]) => t === 'execution_error')?.[1]
  const msg = typeof err?.exception_message === 'string' ? err.exception_message.trim() : ''
  const node = typeof err?.node_type === 'string' ? ` (${err.node_type})` : ''
  return msg ? msg + node : 'ComfyUI stopped the 3D run with an error.'
}

function cancelled(): Error {
  const e = new Error('Cancelled')
  e.name = 'AbortError'
  return e
}

const NO_MODEL = 'The run finished, but no 3D model came out of it. The ComfyUI log says why.'
const POLL_MS = 10_000

/**
 * Queue the 3D graph for one uploaded picture and wait for its GLB.
 *
 * Progress comes over ComfyUI's socket; the history is polled every ten
 * seconds as well, so a missed completion or a socket that never came up
 * still ends the run. Cancel takes this prompt out of ComfyUI's queue (or
 * interrupts it when it is the one running) and nothing else.
 */
export async function runComfyThreeD(opts: RunComfyThreeDOptions): Promise<ComfyUIOutput> {
  const { signal, onProgress } = opts
  if (signal?.aborted) throw cancelled()
  onProgress?.(MESH3D_PHASE_TEXT.load, 0)
  const graph = await buildLocalThreeDWorkflow({
    image: opts.imageName,
    detail: opts.detail,
    cutout: opts.cutout,
    seed: resolveRunSeed(opts.seed ?? -1),
  })
  if (signal?.aborted) throw cancelled()

  let useWS = false
  let mark = 0
  try {
    await comfyWS.connect(3000)
    useWS = true
    mark = comfyWS.mark()
  } catch { /* the history poll below carries the run alone */ }

  const promptId = await submitWorkflow(graph, CLIENT_ID)
  const progress = createThreeDProgress(graph, opts.cutout)

  return await new Promise<ComfyUIOutput>((resolve, reject) => {
    let settled = false
    let gone = 0
    let off: (() => void) | null = null
    let poll: ReturnType<typeof setInterval> | null = null

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      off?.()
      if (poll) clearInterval(poll)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const fail = (message: string) => finish(() => reject(new Error(message)))
    const fromHistory = (history: ComfyHistoryEntry | null): boolean => {
      if (!history) return false
      const status = history.status?.status_str
      if (status === 'error') { fail(historyError(history)); return true }
      if (status !== 'success' && history.status?.completed !== true) return false
      const file = threeDOutputFromHistory(history)
      if (!file) { fail(NO_MODEL); return true }
      onProgress?.(MESH3D_PHASE_TEXT.save, 100)
      finish(() => resolve(file))
      return true
    }
    function onAbort() {
      void abandonPrompt(promptId)
      finish(() => reject(cancelled()))
    }
    signal?.addEventListener('abort', onAbort)

    if (useWS) {
      off = comfyWS.on((event: ComfyWSEvent) => {
        if (settled) return
        if ('prompt_id' in event.data && event.data.prompt_id !== promptId) return
        // ComfyUI says "finished" as execution_success (the desktop's socket
        // proxy may name it execution_complete) and as an `executing` with no
        // node. Any of the three looks into the history.
        const checkHistory = () => { void getHistory(promptId).then((h) => { if (!settled) fromHistory(h) }) }
        if ((event as { type: string }).type === 'execution_success') { checkHistory(); return }
        switch (event.type) {
          case 'executing': {
            const r = progress.executing(event.data.node)
            onProgress?.(r.line, r.percent)
            if (event.data.node === null) checkHistory()
            break
          }
          case 'execution_cached': {
            const r = progress.cached(event.data.nodes ?? [])
            onProgress?.(r.line, r.percent)
            break
          }
          case 'progress': {
            const r = progress.step(event.data.value, event.data.max)
            onProgress?.(r.line, r.percent)
            break
          }
          case 'execution_complete':
            checkHistory()
            break
          case 'execution_error': {
            const msg = (event.data.exception_message || 'ComfyUI stopped the 3D run with an error.').trim()
            fail(msg + (event.data.node_type ? ` (${event.data.node_type})` : ''))
            break
          }
        }
      }, mark)
    }

    poll = setInterval(() => {
      if (settled) return
      void (async () => {
        if (fromHistory(await getHistory(promptId))) return
        // Not in the history and not in the queue: ComfyUI dropped it (a
        // restart, a cleared queue). Twice in a row, so a run that is just
        // moving from the queue into the history is not called lost.
        const state = await promptQueueState(promptId).catch(() => 'unknown' as const)
        gone = state === 'gone' ? gone + 1 : 0
        if (gone >= 2 && !fromHistory(await getHistory(promptId))) {
          fail('ComfyUI no longer has this 3D run. It may have restarted. Try again.')
        }
      })()
    }, POLL_MS)
  })
}
