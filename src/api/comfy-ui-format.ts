/**
 * The regular ComfyUI save format (what "Save" and "Export" write, with
 * `nodes` and `links`), turned into the API format every other part of this
 * app reads (GitHub Discussion #124).
 *
 * The regular format does not name its widget inputs. A node carries
 * `widgets_values`, a positional list, and only the node definition that
 * ComfyUI serves under `/object_info` says which value belongs to which input.
 * So this module never guesses: every node it keeps needs its definition, and
 * a value whose type does not fit the definition rejects the file instead of
 * landing on the wrong input.
 *
 * What it does, following what the ComfyUI canvas itself does when it queues
 * a graph:
 *   - Reroute, PrimitiveNode and the KJNodes SetNode/GetNode pair are canvas
 *     helpers. They are resolved to the real source (or the primitive's value)
 *     and left out.
 *   - Note and MarkdownNote are left out.
 *   - A bypassed node (mode 4) passes its matching input straight through.
 *   - A muted node (mode 2) is left out, and so is every input fed by it.
 *   - Nodes that feed no output node do not run in ComfyUI either and are left
 *     out, so a stray prompt box cannot be taken for the real one.
 *   - Subgraphs are unpacked first (flattenSubgraphs), the way the canvas
 *     unpacks them when it queues: every instance gets its own inner nodes
 *     with ids like "57:27", nested subgraphs are unpacked too, and a bypassed
 *     or muted subgraph node behaves like any bypassed or muted node.
 *   - The older group nodes are rejected with a reason.
 *
 * Pure: the definitions are passed in, nothing here talks to ComfyUI.
 */
import type { ComfyApiGraph, ComfyApiNode, ComfyInputValue, ComfyNodeInputs } from '../types/comfy-graph'

// ── Shapes ──────────────────────────────────────────────────────

export interface UiNodeInput {
  name: string
  type?: string
  link?: number | null
  widget?: { name?: string }
}

export interface UiNodeOutput {
  name?: string
  type?: string
}

export interface UiNode {
  id: number | string
  type: string
  mode?: number
  title?: string
  inputs?: UiNodeInput[]
  outputs?: UiNodeOutput[]
  widgets_values?: unknown
  properties?: Record<string, unknown>
}

export interface UiGraph {
  nodes: UiNode[]
  links?: unknown[]
  definitions?: { subgraphs?: unknown[] }
  extra?: { groupNodes?: Record<string, unknown> }
}

/** One entry of `definitions.subgraphs` (the parts read here). */
interface UiSubgraph {
  id: string
  name?: string
  nodes: UiNode[]
  links: unknown[]
  inputs: { name: string; type?: string; linkIds?: number[] }[]
  outputs: { name?: string; type?: string }[]
  inputNode?: { id?: number | string }
  outputNode?: { id?: number | string }
}

/** One node definition as `/object_info/<Type>` serves it (the parts read here). */
export interface ComfyNodeDef {
  input?: {
    required?: Record<string, unknown>
    optional?: Record<string, unknown>
  }
  input_order?: { required?: string[]; optional?: string[] }
  output?: unknown[]
  output_node?: boolean
  display_name?: string
}

export type ComfyNodeDefs = Record<string, ComfyNodeDef>

export type UiConvertResult =
  | { ok: true; graph: ComfyApiGraph; notes: string[] }
  | { ok: false; reason: string; missingNodeTypes?: string[] }

interface UiLink {
  id: number
  from: string
  fromSlot: number
  to: string
  toSlot: number
  type?: string
}

// ── Guards ──────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isUiNode(v: unknown): v is UiNode {
  return isRecord(v)
    && (typeof v.id === 'number' || typeof v.id === 'string')
    && typeof v.type === 'string'
}

/** The regular save format: a `nodes` list whose entries carry `id` and `type`. */
export function isComfyUiGraph(v: unknown): v is UiGraph {
  if (!isRecord(v) || !Array.isArray(v.nodes)) return false
  if (v.links !== undefined && !Array.isArray(v.links)) return false
  return v.nodes.length > 0 && v.nodes.every(isUiNode)
}

// ── Node kinds ──────────────────────────────────────────────────

const MODE_MUTED = 2
const MODE_BYPASS = 4

const NOTE_TYPES = new Set(['Note', 'MarkdownNote'])
/** Canvas helpers that are resolved, never sent. */
const HELPER_TYPES = new Set(['Reroute', 'PrimitiveNode', 'SetNode', 'GetNode'])

const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize', 'increment-wrap'])
const UPLOAD_VALUES = new Set(['image', 'video', 'audio'])
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

function nodeKey(node: UiNode): string {
  return String(node.id)
}

function label(node: UiNode): string {
  return `#${nodeKey(node)} (${node.type})`
}

function linkedInputs(node: UiNode): UiNodeInput[] {
  return (node.inputs ?? []).filter((i) => isRecord(i) && typeof i.link === 'number')
}

function readLinks(raw: unknown[] | undefined): Map<number, UiLink> {
  const out = new Map<number, UiLink>()
  for (const l of raw ?? []) {
    if (Array.isArray(l) && l.length >= 5 && typeof l[0] === 'number') {
      out.set(l[0], {
        id: l[0], from: String(l[1]), fromSlot: Number(l[2]),
        to: String(l[3]), toSlot: Number(l[4]),
        type: typeof l[5] === 'string' ? l[5] : undefined,
      })
    } else if (isRecord(l) && typeof l.id === 'number') {
      out.set(l.id, {
        id: l.id, from: String(l.origin_id), fromSlot: Number(l.origin_slot),
        to: String(l.target_id), toSlot: Number(l.target_slot),
        type: typeof l.type === 'string' ? l.type : undefined,
      })
    }
  }
  return out
}

/**
 * The node types whose definitions the conversion needs: every node that is
 * neither a note nor a canvas helper. Ask ComfyUI for exactly these.
 */
export function uiGraphNodeTypes(ui: UiGraph): string[] {
  const flat = flattenSubgraphs(ui)
  if (!flat.ok) return []
  // A bypassed or muted subgraph node stays packed and never runs, so its
  // subgraph id is not a node type to ask ComfyUI about.
  const subgraphIds = new Set<string>()
  for (const sg of ui.definitions?.subgraphs ?? []) {
    if (isRecord(sg) && typeof sg.id === 'string') subgraphIds.add(sg.id)
  }
  const types = new Set<string>()
  for (const node of flat.graph.nodes) {
    if (NOTE_TYPES.has(node.type) || HELPER_TYPES.has(node.type) || subgraphIds.has(node.type)) continue
    types.add(node.type)
  }
  return [...types].sort()
}

/**
 * What rules a file out before ComfyUI is even asked: the older group nodes
 * (their inner nodes live in `extra.groupNodes` and are not unpacked here) and
 * subgraphs that cannot be unpacked.
 */
export function uiGraphProblem(ui: UiGraph): string | null {
  const groupNodeNames = new Set(Object.keys(isRecord(ui.extra?.groupNodes) ? ui.extra.groupNodes : {}))
  const scan = (nodes: unknown[]): string | null => {
    for (const node of nodes) {
      if (!isUiNode(node)) continue
      if (node.type.startsWith('workflow>') || node.type.startsWith('workflow/') || groupNodeNames.has(node.type)) {
        return 'This workflow uses group nodes, which this import cannot unpack. '
          + 'In ComfyUI, export it with Save (API Format), or convert the group nodes back and save again.'
      }
    }
    return null
  }
  const inMain = scan(ui.nodes)
  if (inMain) return inMain
  for (const sg of ui.definitions?.subgraphs ?? []) {
    const inSub = isRecord(sg) && Array.isArray(sg.nodes) ? scan(sg.nodes) : null
    if (inSub) return inSub
  }
  const flat = flattenSubgraphs(ui)
  return flat.ok ? null : flat.reason
}

// ── Subgraphs ───────────────────────────────────────────────────

/** Where the canvas puts a subgraph's own input and output slots. */
const SUBGRAPH_INPUT_NODE = -10
const SUBGRAPH_OUTPUT_NODE = -20
const MAX_SUBGRAPH_DEPTH = 16
const MAX_FLAT_NODES = 10_000

function readSubgraph(raw: unknown): UiSubgraph | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null
  if (!Array.isArray(raw.nodes) || !raw.nodes.every(isUiNode)) return null
  const links = raw.links ?? []
  const inputs = raw.inputs ?? []
  const outputs = raw.outputs ?? []
  if (!Array.isArray(links) || !Array.isArray(inputs) || !Array.isArray(outputs)) return null
  if (!inputs.every((i) => isRecord(i) && typeof i.name === 'string')) return null
  if (!outputs.every(isRecord)) return null
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    nodes: raw.nodes,
    links,
    inputs: inputs as UiSubgraph['inputs'],
    outputs: outputs as UiSubgraph['outputs'],
    inputNode: isRecord(raw.inputNode) ? raw.inputNode as UiSubgraph['inputNode'] : undefined,
    outputNode: isRecord(raw.outputNode) ? raw.outputNode as UiSubgraph['outputNode'] : undefined,
  }
}

/** One graph being unpacked: the main graph, or one instance of a subgraph. */
interface Level {
  nodes: Map<string, UiNode>
  links: Map<number, UiLink>
  /** Prefix for the flat ids of this level's nodes: "" for the main graph, "57:" inside node 57. */
  prefix: string
  inputNodeId: string
  outputNodeId: string
  sg: UiSubgraph | null
  /** The subgraph node this level belongs to, in its parent level. */
  parent: { level: Level; node: UiNode; values: Map<string, unknown> } | null
  depth: number
}

type FlatSource =
  | { kind: 'link'; nodeId: string; slot: number; type?: string }
  | { kind: 'value'; value: unknown }
  | { kind: 'none' }

export type FlattenResult =
  | { ok: true; graph: UiGraph; unpacked: number }
  | { ok: false; reason: string }

class FlattenError extends Error {}

/**
 * The values a subgraph node of the older frontend keeps in its own
 * `widgets_values`: one per subgraph input that feeds a widget inside, in
 * the order of the subgraph inputs. The newer frontend keeps them on the
 * inner nodes instead (`properties.proxyWidgets`) and leaves this list empty.
 */
function outerWidgetValues(node: UiNode, sg: UiSubgraph, links: Map<number, UiLink>, inner: Map<string, UiNode>): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const vals = node.widgets_values
  if (isRecord(vals)) {
    for (const input of sg.inputs) if (input.name in vals) out.set(input.name, vals[input.name])
    return out
  }
  if (!Array.isArray(vals) || vals.length === 0) return out
  const widgetInputs = sg.inputs.filter((input) => (input.linkIds ?? []).some((id) => {
    const link = links.get(id)
    const target = link ? inner.get(link.to) : undefined
    const socket = target?.inputs?.[link?.toSlot ?? -1]
    return isRecord(socket) && isRecord(socket.widget)
  }))
  if (widgetInputs.length !== vals.length) {
    throw new FlattenError(`The subgraph node ${label(node)} keeps ${vals.length} settings for ${widgetInputs.length} inputs, `
      + 'so they cannot be matched safely. Open the workflow in this ComfyUI, save it again and retry, '
      + 'or export it with Save (API Format).')
  }
  widgetInputs.forEach((input, i) => out.set(input.name, vals[i]))
  return out
}

/**
 * Subgraphs unpacked into one flat graph, which the conversion below then
 * reads like any other file. What the canvas does when it queues a subgraph:
 *   - each instance gets its own copy of the inner nodes, id "<outer>:<inner>",
 *     nested instances "<outer>:<middle>:<inner>";
 *   - a wire into a subgraph input comes from whatever feeds that input on the
 *     subgraph node outside, a wire from a subgraph output from whatever feeds
 *     that output inside;
 *   - an input left open on the subgraph node takes the value kept on the node
 *     (older files) or else the inner widget's own value (newer files, where
 *     the outer widgets are only proxies of the inner ones);
 *   - a bypassed or muted subgraph node is not unpacked and stays as one node
 *     in that mode, so it passes its input through or is left out as a whole.
 * A file without subgraph nodes comes back unchanged.
 */
export function flattenSubgraphs(ui: UiGraph): FlattenResult {
  const defs = new Map<string, unknown>()
  for (const raw of ui.definitions?.subgraphs ?? []) {
    if (isRecord(raw) && typeof raw.id === 'string') defs.set(raw.id, raw)
  }
  const usesSubgraph = (nodes: UiNode[]) => nodes.some((n) => defs.has(n.type))
  if (defs.size === 0 || !usesSubgraph(ui.nodes)) return { ok: true, graph: ui, unpacked: 0 }

  const parsed = new Map<string, UiSubgraph>()
  const subgraphOf = (node: UiNode): UiSubgraph | null => {
    if (!defs.has(node.type)) return null
    let sg = parsed.get(node.type)
    if (!sg) {
      const read = readSubgraph(defs.get(node.type))
      if (!read) throw new FlattenError(`The subgraph used by node ${label(node)} could not be read. Open the workflow in ComfyUI and save it again.`)
      sg = read
      parsed.set(node.type, sg)
    }
    return sg
  }
  const expands = (node: UiNode) => defs.has(node.type) && node.mode !== MODE_MUTED && node.mode !== MODE_BYPASS

  const levelOf = (nodes: UiNode[], rawLinks: unknown[], prefix: string, sg: UiSubgraph | null, parent: Level['parent'], depth: number): Level => {
    const map = new Map<string, UiNode>()
    for (const n of nodes) map.set(nodeKey(n), n)
    return {
      nodes: map,
      links: readLinks(rawLinks),
      prefix,
      inputNodeId: String(sg?.inputNode?.id ?? SUBGRAPH_INPUT_NODE),
      outputNodeId: String(sg?.outputNode?.id ?? SUBGRAPH_OUTPUT_NODE),
      sg,
      parent,
      depth,
    }
  }
  const children = new Map<string, Level>()
  const childLevel = (level: Level, node: UiNode): Level => {
    const prefix = `${level.prefix}${nodeKey(node)}:`
    const known = children.get(prefix)
    if (known) return known
    const sg = subgraphOf(node) as UiSubgraph
    if (level.depth + 1 > MAX_SUBGRAPH_DEPTH) {
      throw new FlattenError(`The subgraphs in this workflow are nested more than ${MAX_SUBGRAPH_DEPTH} levels deep or contain themselves.`)
    }
    const child = levelOf(sg.nodes, sg.links, prefix, sg, null, level.depth + 1)
    const values = outerWidgetValues(node, sg, child.links, child.nodes)
    child.parent = { level, node, values }
    children.set(prefix, child)
    return child
  }

  // Where a wire really starts, across subgraph borders.
  const originOf = (level: Level, originId: string, slot: number, guard: number): FlatSource => {
    if (guard > 256) throw new FlattenError('The wires of the subgraphs in this workflow run in a circle.')
    if (originId === level.inputNodeId && level.sg) {
      const parent = level.parent
      const sgInput = level.sg.inputs[slot]
      if (!parent || !sgInput) return { kind: 'none' }
      const outerInputs = (parent.node.inputs ?? []).filter((i) => isRecord(i))
      const outer = outerInputs.find((i) => i.name === sgInput.name)
      if (outer && typeof outer.link === 'number') return linkOrigin(parent.level, outer.link, guard + 1)
      if (parent.values.has(sgInput.name)) return { kind: 'value', value: parent.values.get(sgInput.name) }
      return { kind: 'none' }
    }
    const node = level.nodes.get(originId)
    if (!node) return { kind: 'none' }
    if (expands(node)) {
      const child = childLevel(level, node)
      const into = [...child.links.values()].find((l) => l.to === child.outputNodeId && l.toSlot === slot)
      return into ? originOf(child, into.from, into.fromSlot, guard + 1) : { kind: 'none' }
    }
    return { kind: 'link', nodeId: `${level.prefix}${nodeKey(node)}`, slot, type: node.outputs?.[slot]?.type }
  }
  const linkOrigin = (level: Level, linkId: number, guard: number): FlatSource => {
    const link = level.links.get(linkId)
    if (!link) return { kind: 'none' }
    const src = originOf(level, link.from, link.fromSlot, guard)
    return src.kind === 'link' && !src.type ? { ...src, type: link.type } : src
  }

  const flatNodes: UiNode[] = []
  const flatLinks: unknown[] = []
  let nextLink = 1
  let unpacked = 0
  const addLink = (fromId: string, fromSlot: number, toId: string, toSlot: number, type: string | undefined): number => {
    const id = nextLink++
    flatLinks.push({ id, origin_id: fromId, origin_slot: fromSlot, target_id: toId, target_slot: toSlot, type: type ?? '*' })
    return id
  }

  const emit = (level: Level): void => {
    for (const node of level.nodes.values()) {
      if (expands(node)) {
        unpacked++
        emit(childLevel(level, node))
        continue
      }
      if (flatNodes.length >= MAX_FLAT_NODES) throw new FlattenError('This workflow unpacks to more nodes than LU can import.')
      const flatId = `${level.prefix}${nodeKey(node)}`
      const inputs = (node.inputs ?? []).map((input, slot): UiNodeInput => {
        if (!isRecord(input) || typeof input.link !== 'number') return input
        const src = linkOrigin(level, input.link, 0)
        if (src.kind === 'link') return { ...input, link: addLink(src.nodeId, src.slot, flatId, slot, src.type ?? input.type) }
        if (src.kind === 'value') {
          // The value kept on the subgraph node, handed in like a Primitive node does.
          const primitiveId = `${flatId}:value:${slot}`
          flatNodes.push({ id: primitiveId, type: 'PrimitiveNode', mode: 0, outputs: [{ type: input.type }], widgets_values: [src.value] })
          return { ...input, link: addLink(primitiveId, 0, flatId, slot, input.type) }
        }
        return { ...input, link: null }
      })
      flatNodes.push({ ...node, id: flatId, inputs })
    }
  }

  try {
    emit(levelOf(ui.nodes, ui.links ?? [], '', null, null, 0))
  } catch (e) {
    if (e instanceof FlattenError) return { ok: false, reason: e.message }
    throw e
  }
  const { definitions: _definitions, ...rest } = ui
  return { ok: true, graph: { ...rest, nodes: flatNodes, links: flatLinks }, unpacked }
}

// ── Widget specs ────────────────────────────────────────────────

function specType(spec: unknown): string | string[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null
  const head = spec[0]
  if (Array.isArray(head)) return head.filter((v): v is string => typeof v === 'string')
  return typeof head === 'string' ? head : null
}

function specOptions(spec: unknown): Record<string, unknown> {
  return Array.isArray(spec) && isRecord(spec[1]) ? spec[1] : {}
}

/**
 * The type the widget of an input has. A V3 input that takes more than one
 * type ("FLOAT,INT", io.MultiType with a widget input) names the widget in
 * `widgetType` (comfy_api/latest/_io.py, WidgetInput.as_dict and
 * MultiType.Input), and the canvas keeps its value like any other widget.
 */
function widgetType(spec: unknown): string | string[] | null {
  const declared = specOptions(spec).widgetType
  return typeof declared === 'string' ? declared : specType(spec)
}

function isWidgetSpec(spec: unknown): boolean {
  const t = widgetType(spec)
  if (t === null) return false
  if (specOptions(spec).forceInput === true) return false
  return Array.isArray(t) || WIDGET_TYPES.has(t.toUpperCase())
}

function hasControlWidget(name: string, spec: unknown): boolean {
  if (specOptions(spec).control_after_generate) return true
  const t = widgetType(spec)
  return t === 'INT' && (name === 'seed' || name === 'noise_seed')
}

function hasUploadWidget(spec: unknown): boolean {
  const o = specOptions(spec)
  return Boolean(o.image_upload || o.video_upload || o.audio_upload)
}

function valueFits(spec: unknown, value: unknown): boolean {
  const t = widgetType(spec)
  if (Array.isArray(t) || t?.toUpperCase() === 'COMBO') return typeof value === 'string' || typeof value === 'number'
  switch (t?.toUpperCase()) {
    case 'INT':
    case 'FLOAT':
      return typeof value === 'number' && Number.isFinite(value)
    case 'BOOLEAN':
      return typeof value === 'boolean'
    case 'STRING':
      return typeof value === 'string'
    default:
      return true
  }
}

function specDefault(spec: unknown): unknown {
  const o = specOptions(spec)
  if (o.default !== undefined) return o.default
  const t = specType(spec)
  if (Array.isArray(t)) return t[0]
  if (Array.isArray(o.options)) return o.options[0]
  return undefined
}

function orderedNames(def: ComfyNodeDef, group: 'required' | 'optional'): string[] {
  const specs = def.input?.[group] ?? {}
  const order = def.input_order?.[group]
  if (Array.isArray(order) && order.every((n) => typeof n === 'string')) {
    // The order list wins, but a name it forgot still gets its turn at the end.
    return [...order.filter((n) => n in specs), ...Object.keys(specs).filter((n) => !order.includes(n))]
  }
  return Object.keys(specs)
}

// ── V3 dynamic inputs ───────────────────────────────────────────
//
// Two input types of the V3 node API stand for a set of inputs rather than
// one (comfy_api/latest/_io.py of ComfyUI v0.42.4):
//   - COMFY_DYNAMICCOMBO_V3 (DynamicCombo): a dropdown whose chosen option
//     brings its own inputs. The canvas keeps their values right after the
//     dropdown's own value, required ones first. The API format names them
//     "<combo>.<input>" (finalize_prefix), nested combos "<a>.<b>.<input>".
//   - COMFY_AUTOGROW_V3 (Autogrow): sockets that grow one by one, named
//     "<input>.<name>" from a list of names or "<input>.<prefix><i>". The
//     first `min` of them are required when the template input is. They are
//     sockets only (the template is forced to an input), never widgets.

const DYNAMIC_COMBO = 'COMFY_DYNAMICCOMBO_V3'
const AUTOGROW = 'COMFY_AUTOGROW_V3'

interface DynamicOption {
  key: string
  inputs: { required: Record<string, unknown>; optional: Record<string, unknown> }
}

function inputGroups(raw: unknown): DynamicOption['inputs'] {
  const groups = isRecord(raw) ? raw : {}
  return {
    required: isRecord(groups.required) ? groups.required : {},
    optional: isRecord(groups.optional) ? groups.optional : {},
  }
}

function dynamicOptions(spec: unknown): DynamicOption[] {
  const raw = specOptions(spec).options
  if (!Array.isArray(raw)) return []
  return raw.flatMap((o): DynamicOption[] => {
    if (!isRecord(o) || (typeof o.key !== 'string' && typeof o.key !== 'number')) return []
    return [{ key: String(o.key), inputs: inputGroups(o.inputs) }]
  })
}

/** The socket names of an Autogrow input, with whether each one is required. */
function autogrowSlots(id: string, spec: unknown): { name: string; spec: unknown; required: boolean }[] {
  const template = specOptions(spec).template
  if (!isRecord(template)) return []
  const groups = inputGroups(template.input)
  const requiredFirst = Object.entries(groups.required)[0]
  const entry = requiredFirst ?? Object.entries(groups.optional)[0]
  if (!entry) return []
  const templateRequired = requiredFirst !== undefined
  const min = typeof template.min === 'number' ? template.min : 1
  let names: string[] = []
  if (Array.isArray(template.names)) {
    names = template.names.filter((n): n is string => typeof n === 'string')
  } else if (typeof template.prefix === 'string' && typeof template.max === 'number') {
    names = Array.from({ length: Math.min(template.max, 100) }, (_, i) => `${template.prefix}${i}`)
  }
  return names.map((n, i) => ({ name: `${id}.${n}`, spec: entry[1], required: templateRequired && i < min }))
}

// ── Conversion ──────────────────────────────────────────────────

type Source =
  | { kind: 'link'; nodeId: string; slot: number }
  | { kind: 'value'; value: unknown }
  | { kind: 'none' }

const NONE: Source = { kind: 'none' }

function settingsMismatch(node: UiNode): string {
  return `Node ${label(node)}: the saved settings do not match the version of this node installed in ComfyUI. `
    + 'Open the workflow in this ComfyUI, save it again and retry, or export it with Save (API Format).'
}

export function convertUiGraph(file: UiGraph, defs: ComfyNodeDefs): UiConvertResult {
  const problem = uiGraphProblem(file)
  if (problem) return { ok: false, reason: problem }
  const flat = flattenSubgraphs(file)
  if (!flat.ok) return { ok: false, reason: flat.reason }
  const ui = flat.graph

  const nodes = new Map<string, UiNode>()
  for (const node of ui.nodes) nodes.set(nodeKey(node), node)
  const links = readLinks(ui.links)
  const notes: string[] = []

  // Nodes ComfyUI does not know. A frontend-only node with no wire in or out
  // (a label, a bookmark) changes nothing and is left out; one that is wired
  // in means a custom node pack is missing.
  const missing = new Set<string>()
  const ignoredUnknown: string[] = []
  const real: UiNode[] = []
  let muted = 0
  let bypassed = 0
  let notesDropped = 0
  for (const node of ui.nodes) {
    if (NOTE_TYPES.has(node.type)) { notesDropped++; continue }
    if (HELPER_TYPES.has(node.type)) continue
    if (node.mode === MODE_MUTED) { muted++; continue }
    if (node.mode === MODE_BYPASS) { bypassed++; continue }
    if (!isRecord(defs[node.type])) {
      const wired = linkedInputs(node).length > 0
        || [...links.values()].some((l) => l.from === nodeKey(node))
      if (wired) missing.add(node.type)
      else ignoredUnknown.push(node.type)
      continue
    }
    real.push(node)
  }
  if (missing.size > 0) {
    const missingNodeTypes = [...missing].sort()
    return {
      ok: false,
      reason: `ComfyUI does not know these nodes: ${missingNodeTypes.join(', ')}. `
        + 'Install the custom nodes they come from, restart ComfyUI and import again.',
      missingNodeTypes,
    }
  }

  const resolve = (linkId: number, depth = 0): Source => {
    if (depth > 64) return NONE
    const link = links.get(linkId)
    if (!link) return NONE
    const src = nodes.get(link.from)
    if (!src) return NONE
    const follow = (input: UiNodeInput | undefined): Source =>
      input && typeof input.link === 'number' ? resolve(input.link, depth + 1) : NONE

    if (src.type === 'Reroute' || src.type === 'SetNode') return follow(src.inputs?.[0])
    if (src.type === 'PrimitiveNode') {
      const vals = src.widgets_values
      return Array.isArray(vals) && vals.length > 0 ? { kind: 'value', value: vals[0] } : NONE
    }
    if (src.type === 'GetNode') {
      const name = Array.isArray(src.widgets_values) ? src.widgets_values[0] : undefined
      const setter = ui.nodes.find((n) =>
        n.type === 'SetNode' && Array.isArray(n.widgets_values) && n.widgets_values[0] === name)
      return follow(setter?.inputs?.[0])
    }
    if (NOTE_TYPES.has(src.type) || src.mode === MODE_MUTED) return NONE
    if (src.mode === MODE_BYPASS) {
      // The canvas hands a bypassed node's input of the same type straight
      // through: the input at the same position first, else the first match.
      const outType = src.outputs?.[link.fromSlot]?.type ?? link.type
      const fits = (i: UiNodeInput | undefined) =>
        !!i && typeof i.link === 'number' && (i.type === outType || i.type === '*' || outType === '*')
      const same = src.inputs?.[link.fromSlot]
      return follow(fits(same) ? same : src.inputs?.find(fits))
    }
    if (!isRecord(defs[src.type])) return NONE
    return { kind: 'link', nodeId: nodeKey(src), slot: link.fromSlot }
  }

  const graph: ComfyApiGraph = {}
  // Per node, the API names of the inputs ComfyUI will ask for.
  const requiredInputs = new Map<string, string[]>()
  for (const node of real) {
    const def = defs[node.type]
    const inputs: ComfyNodeInputs = {}
    const required: string[] = []
    const vals = node.widgets_values
    const byName = isRecord(vals) ? vals : null
    const positional = Array.isArray(vals) ? vals : []
    let cursor = 0

    const sockets = new Map<string, UiNodeInput>()
    for (const input of node.inputs ?? []) {
      if (!isRecord(input) || typeof input.name !== 'string') continue
      sockets.set(input.name, input)
      if (typeof input.widget?.name === 'string') sockets.set(input.widget.name, input)
    }

    const nextValue = (name: string, spec: unknown): unknown => {
      if (byName) return byName[name]
      if (cursor >= positional.length) return undefined
      const value = positional[cursor++]
      const shortName = name.slice(name.lastIndexOf('.') + 1)
      if (hasControlWidget(shortName, spec) && CONTROL_VALUES.has(positional[cursor] as string)) cursor++
      if (hasUploadWidget(spec) && UPLOAD_VALUES.has(positional[cursor] as string)) cursor++
      return value
    }

    /** One input by its API name. False: the saved values do not fit the definition. */
    const readInput = (name: string, spec: unknown, isRequired: boolean, socketOnly = false): boolean => {
      const type = specType(spec)
      if (type === DYNAMIC_COMBO) {
        const options = dynamicOptions(spec)
        let value = nextValue(name, spec)
        if (value === undefined && isRequired) value = specOptions(spec).default ?? options[0]?.key
        if (value === undefined) return true
        const chosen = options.find((o) => o.key === String(value))
        if (!chosen) return false
        inputs[name] = value as ComfyInputValue
        if (isRequired) required.push(name)
        for (const [group, specs] of Object.entries(chosen.inputs)) {
          for (const [child, childSpec] of Object.entries(specs)) {
            if (!readInput(`${name}.${child}`, childSpec, group === 'required')) return false
          }
        }
        return true
      }
      if (type === AUTOGROW) {
        for (const slot of autogrowSlots(name, spec)) {
          if (!readInput(slot.name, slot.spec, slot.required, true)) return false
        }
        return true
      }

      if (isRequired) required.push(name)
      const widget = !socketOnly && isWidgetSpec(spec)
      let value: unknown
      if (widget) {
        value = nextValue(name, spec)
        if (value !== undefined && !valueFits(spec, value)) return false
      }

      const socket = sockets.get(name)
      if (socket && typeof socket.link === 'number') {
        const src = resolve(socket.link)
        if (src.kind === 'link') { inputs[name] = [src.nodeId, src.slot]; return true }
        if (src.kind === 'value') {
          if (widget && !valueFits(spec, src.value)) return false
          inputs[name] = src.value as ComfyInputValue
          return true
        }
      }

      if (widget && value === undefined && isRequired) value = specDefault(spec)
      if (value !== undefined) inputs[name] = value as ComfyInputValue
      return true
    }

    for (const group of ['required', 'optional'] as const) {
      for (const name of orderedNames(def, group)) {
        if (!readInput(name, def.input?.[group]?.[name], group === 'required')) {
          return { ok: false, reason: settingsMismatch(node) }
        }
      }
    }

    const apiNode: ComfyApiNode = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title || def.display_name || node.type },
    }
    graph[nodeKey(node)] = apiNode
    requiredInputs.set(nodeKey(node), required)
  }

  // Keep what an output node needs, the same set ComfyUI would run.
  const outputs = Object.keys(graph).filter((id) => defs[graph[id].class_type]?.output_node === true)
  if (outputs.length === 0) {
    return { ok: false, reason: 'This workflow has no output node (for example Save Image), so it would not produce anything.' }
  }
  const keep = new Set<string>()
  const stack = [...outputs]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (keep.has(id) || !graph[id]) continue
    keep.add(id)
    for (const v of Object.values(graph[id].inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number') stack.push(v[0])
    }
  }
  let unconnected = 0
  for (const id of Object.keys(graph)) {
    if (!keep.has(id)) { delete graph[id]; unconnected++ }
  }

  // A required input left open fails in ComfyUI as well. Say which one now.
  for (const node of real) {
    const id = nodeKey(node)
    if (!graph[id]) continue
    for (const name of requiredInputs.get(id) ?? []) {
      if (graph[id].inputs?.[name] === undefined) {
        return {
          ok: false,
          reason: `Node ${label(node)} has no "${name}" connected. It would fail in ComfyUI as well. Connect it and save again.`,
        }
      }
    }
  }

  if (flat.unpacked) notes.push(`${flat.unpacked} subgraph${flat.unpacked === 1 ? '' : 's'} unpacked`)
  if (bypassed) notes.push(`${bypassed} bypassed node${bypassed === 1 ? '' : 's'} passed through`)
  if (muted) notes.push(`${muted} muted node${muted === 1 ? '' : 's'} left out`)
  if (notesDropped) notes.push(`${notesDropped} note${notesDropped === 1 ? '' : 's'} left out`)
  if (unconnected) notes.push(`${unconnected} unconnected node${unconnected === 1 ? '' : 's'} left out`)
  if (ignoredUnknown.length) notes.push(`canvas-only nodes left out: ${[...new Set(ignoredUnknown)].join(', ')}`)

  return { ok: true, graph, notes }
}
