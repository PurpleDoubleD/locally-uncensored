/**
 * Every value of an imported ComfyUI workflow, as a list Create can edit
 * (GitHub wish #8: VAE, CLIP skip, sampler, scheduler, everything a node
 * holds as a value, not only the fixed fields of ParameterMap).
 *
 * Three parts, all pure:
 *  - `luSetInputs` names the inputs LU writes itself on every run (prompt,
 *    seed, size, model and the rest found by autoDetectParameterMap). Those
 *    are not offered a second time. The VAE and text encoder loaders are a
 *    special case: LU keeps the file the workflow names when ComfyUI has it
 *    and picks a matching one when not, but a value the user chose wins.
 *  - `listWorkflowParams` walks the graph and returns, per node, its value
 *    inputs (never a connected input) with the control that fits: from the
 *    node definition of `/object_info` when there is one, else from the value.
 *  - `applyParamOverrides` writes the user's values into the graph for a run.
 *
 * Only reads types and the combo reader, so it cannot join an import cycle
 * with workflows.ts, which imports it.
 */
import type { ParameterMap, ParameterMapping } from '../types/workflows'
import type { ComfyApiGraph, ComfyInputValue } from '../types/comfy-graph'
import { apiNodes, inputNumber, isComfyLinkRef } from '../types/comfy-graph'
import type { ComfyNodeDef, ComfyNodeDefs } from './comfy-ui-format'
import { readComboOptions } from './comfyui-enum'
import { resolutionSelectorIds, withDetectedPrompts } from './workflow-graph-detect'

/** A value the list can show and the user can set. */
export type ParamValue = string | number | boolean

/** Overrides of one workflow: node id, then input name, then the value. */
export type WorkflowParamOverrides = Record<string, Record<string, ParamValue>>

export type ParamControl =
  | { kind: 'number'; integer: boolean; min?: number; max?: number; step?: number }
  | { kind: 'select'; options: string[] }
  | { kind: 'text'; multiline: boolean }
  | { kind: 'toggle' }

export interface WorkflowParamField {
  nodeId: string
  inputKey: string
  /** The value in the workflow file. */
  fileValue: ParamValue
  control: ParamControl
  /** LU picks this value on its own (VAE, text encoder) unless the user sets one. */
  autoByLu: boolean
}

export interface WorkflowParamNode {
  nodeId: string
  /** The node title, or its type when it has none of its own. */
  title: string
  classType: string
  fields: WorkflowParamField[]
  /** What LU sets on this node itself, as names for the "Set by LU" line. */
  setByLu: string[]
}

interface LuSetInput {
  label: string
  /** True: LU picks a value, but an override from the user wins. */
  auto: boolean
}

const MAP_LABELS: Record<keyof ParameterMap, string> = {
  model: 'Model',
  positivePrompt: 'Prompt',
  negativePrompt: 'Negative prompt',
  seed: 'Seed',
  steps: 'Steps',
  cfgScale: 'CFG',
  width: 'Width',
  height: 'Height',
  batchSize: 'Batch size',
  sampler: 'Sampler',
  scheduler: 'Scheduler',
  inputImage: 'Source image',
  inputVideo: 'Driving video',
  frames: 'Frames',
  fps: 'FPS',
}

/**
 * Which way a workflow runs. 'workflow': a normal Create run, filled by
 * injectParameters (prompt, seed, steps, CFG, size, sampler and the rest).
 * 'lane': a Motion Control run, filled by injectLaneParameters, which sets
 * only the fields in LANE_SET_FIELDS and leaves every other value as the
 * workflow file has it, so those stay editable in the list.
 */
export type WorkflowRunPath = 'workflow' | 'lane'

/** The fields of ParameterMap that injectLaneParameters writes. Besides
 *  these it turns save_output of a VHS_VideoCombine on, as a normal run does. */
export const LANE_SET_FIELDS = [
  'model', 'seed', 'inputImage', 'inputVideo',
] as const satisfies readonly (keyof ParameterMap)[]

export function paramKey(nodeId: string, inputKey: string): string {
  return JSON.stringify([nodeId, inputKey])
}

/**
 * The inputs LU writes itself on a run, keyed by `paramKey`. On the
 * 'workflow' path that is injectParameters, with its fallbacks (a resize node
 * for the size, the first image loader for the source image, the VAE and
 * text encoder it picks), so nothing LU overwrites shows up as editable. On
 * the 'lane' path it is only what injectLaneParameters writes (and the
 * video saver both turn on).
 */
export function luSetInputs(
  workflow: ComfyApiGraph,
  paramMap: ParameterMap,
  path: WorkflowRunPath = 'workflow',
): Map<string, LuSetInput> {
  const out = new Map<string, LuSetInput>()
  const mark = (m: ParameterMapping | undefined, label: string, auto = false) => {
    if (m) out.set(paramKey(m.nodeId, m.inputKey), { label, auto })
  }
  const nodes = apiNodes(workflow)
  // Both ways turn the video saver on (workflows.ts forceSavedOutput).
  for (const [id, n] of nodes) {
    if (n.class_type === 'VHS_VideoCombine') mark({ nodeId: id, inputKey: 'save_output' }, 'Save output')
  }
  if (path === 'lane') {
    for (const name of LANE_SET_FIELDS) mark(paramMap[name], MAP_LABELS[name])
    return out
  }
  // The prompt boxes as injectParameters finds them on a run.
  const runMap = withDetectedPrompts(workflow, paramMap)
  for (const [name, label] of Object.entries(MAP_LABELS) as [keyof ParameterMap, string][]) {
    mark(runMap[name], label)
  }
  let sized = !!paramMap.width || !!paramMap.height
  if (!paramMap.width || !paramMap.height) {
    const resize = nodes.find(([, n]) => n.class_type === 'ImageResizeKJv2'
      && inputNumber(n, 'width') !== undefined && inputNumber(n, 'height') !== undefined)
    if (resize) {
      sized = true
      if (!paramMap.width) mark({ nodeId: resize[0], inputKey: 'width' }, 'Width')
      if (!paramMap.height) mark({ nodeId: resize[0], inputKey: 'height' }, 'Height')
    }
  }
  // Without a size to write, LU's size picks the aspect ratio.
  if (!sized) {
    for (const id of resolutionSelectorIds(workflow)) mark({ nodeId: id, inputKey: 'aspect_ratio' }, 'Aspect ratio')
  }
  if (!paramMap.inputImage) {
    const load = nodes.find(([, n]) => n.class_type === 'LoadImage')
    if (load) mark({ nodeId: load[0], inputKey: 'image' }, 'Source image')
  }
  for (const [id, n] of nodes) {
    if (n.class_type === 'VAELoader') mark({ nodeId: id, inputKey: 'vae_name' }, 'VAE', true)
    if (n.class_type === 'CLIPLoader') {
      mark({ nodeId: id, inputKey: 'clip_name' }, 'Text encoder', true)
      mark({ nodeId: id, inputKey: 'type' }, 'Text encoder type', true)
    }
  }
  return out
}

// ── Controls ────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isParamValue(v: unknown): v is ParamValue {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function inputSpec(def: ComfyNodeDef | undefined, key: string): unknown {
  return def?.input?.required?.[key] ?? def?.input?.optional?.[key]
}

function maxOf(v: unknown): number | undefined {
  const n = finite(v)
  return n !== undefined && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : undefined
}

/** The control a node definition asks for, or null when it says nothing usable. */
function controlFromSpec(spec: unknown, value: ParamValue): ParamControl | null {
  if (!Array.isArray(spec) || spec.length === 0) return null
  const head = spec[0]
  const opts = isRecord(spec[1]) ? spec[1] : {}
  const type = typeof head === 'string' ? head.toUpperCase() : null
  if (Array.isArray(head) || type === 'COMBO') {
    const options = readComboOptions(spec) ?? []
    const current = String(value)
    // A file saved on another machine may name a file this ComfyUI lacks.
    // It stays choosable, otherwise the select would silently show another.
    return { kind: 'select', options: options.includes(current) ? options : [current, ...options] }
  }
  switch (type) {
    case 'INT':
    case 'FLOAT':
      // A value of another kind than the definition says: follow the value.
      if (typeof value !== 'number') return null
      return {
        kind: 'number',
        integer: type === 'INT',
        min: finite(opts.min),
        // ComfyUI states the seed limit as 2^64 - 1, beyond what a JS number
        // holds exactly; such a limit only says "no limit" in practice.
        max: maxOf(opts.max),
        step: finite(opts.step) ?? (type === 'INT' ? 1 : undefined),
      }
    case 'BOOLEAN':
      return typeof value === 'boolean' ? { kind: 'toggle' } : null
    case 'STRING':
      if (typeof value !== 'string') return null
      return { kind: 'text', multiline: opts.multiline === true }
    default:
      return null
  }
}

function controlFromValue(value: ParamValue): ParamControl {
  if (typeof value === 'boolean') return { kind: 'toggle' }
  if (typeof value === 'number') return { kind: 'number', integer: Number.isInteger(value) }
  return { kind: 'text', multiline: value.length > 80 || value.includes('\n') }
}

function inputOrder(def: ComfyNodeDef | undefined, keys: string[]): string[] {
  if (!def) return keys
  const declared = [
    ...(def.input_order?.required ?? Object.keys(def.input?.required ?? {})),
    ...(def.input_order?.optional ?? Object.keys(def.input?.optional ?? {})),
  ].filter((k) => typeof k === 'string')
  const rank = (k: string) => {
    const i = declared.indexOf(k)
    return i === -1 ? declared.length : i
  }
  return [...keys].sort((a, b) => rank(a) - rank(b))
}

function byNodeId(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b, undefined, { numeric: true })
}

/**
 * Every node with at least one value input, in node id order. `defs` is the
 * `/object_info` answer for the node types, or null when ComfyUI is not up:
 * then the controls follow the values (a number field, a switch, a text).
 */
export function listWorkflowParams(
  workflow: ComfyApiGraph,
  paramMap: ParameterMap,
  defs: ComfyNodeDefs | null,
  path: WorkflowRunPath = 'workflow',
): WorkflowParamNode[] {
  const luSet = luSetInputs(workflow, paramMap, path)
  const out: WorkflowParamNode[] = []
  const nodes = [...apiNodes(workflow)].sort((a, b) => byNodeId(a[0], b[0]))
  for (const [nodeId, node] of nodes) {
    const inputs = isRecord(node.inputs) ? node.inputs : {}
    const def = defs?.[node.class_type]
    const fields: WorkflowParamField[] = []
    const setByLu: string[] = []
    for (const inputKey of inputOrder(def, Object.keys(inputs))) {
      const value: unknown = inputs[inputKey]
      if (isComfyLinkRef(value) || !isParamValue(value)) continue
      const lu = luSet.get(paramKey(nodeId, inputKey))
      if (lu && !lu.auto) {
        setByLu.push(lu.label)
        continue
      }
      const control = controlFromSpec(inputSpec(def, inputKey), value) ?? controlFromValue(value)
      fields.push({ nodeId, inputKey, fileValue: value, control, autoByLu: Boolean(lu?.auto) })
    }
    if (fields.length === 0 && setByLu.length === 0) continue
    const metaTitle = node._meta?.title?.trim()
    out.push({
      nodeId,
      title: metaTitle || def?.display_name || node.class_type,
      classType: node.class_type,
      fields,
      setByLu,
    })
  }
  return out
}

/** The node types of a graph, once each, for the `/object_info` calls. */
export function workflowNodeTypes(workflow: ComfyApiGraph): string[] {
  return [...new Set(apiNodes(workflow).map(([, n]) => n.class_type))]
}

/**
 * The user's values written into a graph (which the caller owns, it is
 * changed in place). Skipped: a node or input the graph no longer has, a
 * connected input, an input LU sets itself, and anything that is not a plain
 * value. A VAE or text encoder the user chose replaces LU's own pick.
 * `path` must be the way the run fills the graph, see WorkflowRunPath.
 */
export function applyParamOverrides(
  wf: ComfyApiGraph,
  paramMap: ParameterMap,
  overrides: WorkflowParamOverrides | undefined,
  path: WorkflowRunPath = 'workflow',
): ComfyApiGraph {
  if (!overrides) return wf
  const luSet = luSetInputs(wf, paramMap, path)
  for (const [nodeId, values] of Object.entries(overrides)) {
    const node = wf[nodeId]
    if (!node || !isRecord(node.inputs) || !isRecord(values)) continue
    for (const [inputKey, value] of Object.entries(values)) {
      if (!(inputKey in node.inputs) || !isParamValue(value)) continue
      const current: ComfyInputValue | undefined = node.inputs[inputKey]
      if (isComfyLinkRef(current)) continue
      const lu = luSet.get(paramKey(nodeId, inputKey))
      if (lu && !lu.auto) continue
      node.inputs[inputKey] = value
    }
  }
  return wf
}
