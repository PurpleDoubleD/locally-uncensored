/**
 * The two ComfyUI graph formats, plus the guards that turn a downloaded or
 * user-picked JSON file into one of them.
 *
 * This is foreign data in the strongest sense in this app: a `.json` the user
 * dropped in, a CivitAI download, a `.png` with a workflow in its metadata.
 * Nothing about its shape is guaranteed, so every walk over a graph narrows
 * through the guards below before it reads a field.
 *
 * Two formats exist and they are NOT interchangeable:
 *
 *   - **API format** — what `/prompt` accepts and what this app builds:
 *     `{ "3": { class_type: "KSampler", inputs: { seed: 1, model: ["4", 0] } } }`.
 *     Node ids are the object keys (strings), and an input is either a literal
 *     or a `[sourceNodeId, slotIndex]` link.
 *
 *   - **Web/UI format** — what the ComfyUI canvas saves: `{ nodes: [...],
 *     links: [...] }`, node ids numeric, inputs positional
 *     (`widgets_values`) and connections in a separate link table.
 *     `convertWebToApiFormat` in api/workflows.ts turns one into the other.
 *
 * Type-only plus pure guards, no imports — a leaf module that cannot join an
 * import cycle.
 */

// ── API format ──────────────────────────────────────────────────

/** A reference to another node's output: `[nodeId, slotIndex]`. */
export type ComfyLinkRef = [string, number]

/**
 * Anything that may sit in a node's `inputs`. Literals and links cover
 * everything ComfyUI itself emits; the array/object arms exist because custom
 * nodes do store structured widget state there.
 */
export type ComfyInputValue =
  | string
  | number
  | boolean
  | null
  | ComfyInputValue[]
  | { [key: string]: ComfyInputValue }

/**
 * A node's `inputs` map.
 *
 * `undefined` is a member on purpose and it is load-bearing: injection writes
 * `undefined` for a mapped-but-unset parameter, and `JSON.stringify` then drops
 * the key from the `/prompt` payload so ComfyUI applies the node's own default
 * — which is not the same as leaving the template's value in place.
 */
export type ComfyNodeInputs = Record<string, ComfyInputValue | undefined>

/**
 * One node of an API-format graph.
 *
 * `inputs` is optional because a downloaded graph really can carry a node
 * without it — the guard below only promises a `class_type`. Read fields
 * through `nodeInput` / `inputString` / `inputNumber`, which re-check.
 */
export interface ComfyApiNode {
  class_type: string
  inputs?: ComfyNodeInputs
  /** ComfyUI's own round-trip metadata; present in saved graphs, ignored here. */
  _meta?: { title?: string }
}

/**
 * An API-format graph as it arrives — node ids are the keys.
 *
 * `Partial` in spirit rather than in types: a downloaded file can hold junk
 * under some key, so readers use `apiNodes()` below instead of iterating the
 * record directly.
 */
export type ComfyApiGraph = Record<string, ComfyApiNode>

// ── Web / UI format ─────────────────────────────────────────────

/** One declared input socket of a canvas node. */
export interface ComfyWebInput {
  name: string
  type?: string
  /** Link id into the graph's `links` table, or null when unconnected. */
  link?: number | null
}

export interface ComfyWebNode {
  id: number
  type: string
  inputs?: ComfyWebInput[]
  /** Positional widget state — order is per node class and undocumented.
   *  Plain parsed JSON, hence ComfyInputValue rather than unknown. */
  widgets_values?: ComfyInputValue[]
  /** Named widget slots, when the canvas saved them — lets an unknown node
   *  type still have its widget values mapped by name. */
  widgets?: { name?: string }[]
  title?: string
}

/** `[linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, type]`. */
export type ComfyWebLink = [number, number, number, number, number, string?]

export interface ComfyWebGraph {
  nodes: ComfyWebNode[]
  links?: unknown[]
}



// ── Guards ──────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A single API-format node: a `class_type` string is the whole signature. */
export function isComfyApiNode(v: unknown): v is ComfyApiNode {
  return isPlainObject(v) && typeof v.class_type === 'string'
}

/**
 * A `[nodeId, slot]` link reference. ComfyUI writes the node id as a string,
 * but hand-edited and older graphs carry a number — both are accepted, and
 * `linkTarget` below normalises to the string form the API wants.
 */
export function isComfyLinkRef(v: unknown): v is [string | number, number] {
  return Array.isArray(v)
    && v.length >= 2
    && (typeof v[0] === 'string' || typeof v[0] === 'number')
    && typeof v[1] === 'number'
}

/** The node id a link points at, or undefined when this is not a link. */
export function linkTarget(v: unknown): string | undefined {
  return isComfyLinkRef(v) ? String(v[0]) : undefined
}

/**
 * The `[id, node]` pairs of an API-format graph, skipping anything that is not
 * a node. Iterate this rather than `Object.entries(graph)` — a graph file can
 * carry `extra`, `version` or a stray comment key next to the real nodes.
 */
export function apiNodes(graph: unknown): [string, ComfyApiNode][] {
  if (!isPlainObject(graph)) return []
  const out: [string, ComfyApiNode][] = []
  for (const [id, node] of Object.entries(graph)) {
    if (isComfyApiNode(node)) out.push([id, node])
  }
  return out
}

/** Is this the API format `/prompt` accepts? At least one real node. */
export function isComfyApiGraph(v: unknown): v is ComfyApiGraph {
  return isPlainObject(v) && Object.values(v).some(isComfyApiNode)
}

/** One canvas node — a numeric id and a class name. */
export function isComfyWebNode(v: unknown): v is ComfyWebNode {
  return isPlainObject(v) && typeof v.type === 'string' && typeof v.id === 'number'
}

/**
 * Is this the canvas save format? Matches the historical check exactly: a
 * `nodes` array holding at least one entry with a string `type`. (Node ids are
 * verified per node by `isComfyWebNode` at conversion time, because a graph
 * with one malformed node should still convert the rest.)
 */
export function isComfyWebGraph(v: unknown): v is ComfyWebGraph {
  return isPlainObject(v)
    && Array.isArray(v.nodes)
    && v.nodes.some((n) => isPlainObject(n) && typeof n.type === 'string')
}

/** Read one input of a node without asserting anything about its type. */
export function nodeInput(node: ComfyApiNode | undefined, key: string): ComfyInputValue | undefined {
  const inputs = node?.inputs
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) return undefined
  return inputs[key]
}

/** An input as a string, or undefined — model names, prompts, filenames. */
export function inputString(node: ComfyApiNode | undefined, key: string): string | undefined {
  const v = nodeInput(node, key)
  return typeof v === 'string' ? v : undefined
}

/** An input as a finite number, or undefined — steps, cfg, width, seed. */
export function inputNumber(node: ComfyApiNode | undefined, key: string): number | undefined {
  const v = nodeInput(node, key)
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}


// ── /history ────────────────────────────────────────────────────

/**
 * One entry of ComfyUI's `/history/<promptId>` response.
 *
 * Only the parts this app reads are modelled, and every one of them is
 * optional because a half-written entry (the render is still going) genuinely
 * omits them. `outputs` stays `unknown` per node: what a node posts depends on
 * the node — `extractComfyOutputFiles` in api/comfyui.ts is the reader that
 * walks it, and it narrows as it goes.
 */
export interface ComfyHistoryEntry {
  status?: {
    status_str?: string
    completed?: boolean
    /** `[eventName, payload]` pairs — execution_start / execution_success / … */
    messages?: [string, ComfyExecutionMessage][]
  }
  outputs?: Record<string, unknown>
  prompt?: unknown
}

/**
 * The payload half of a `/history` status message. The named fields are the
 * ones this app surfaces to the user when a render fails (they come from
 * ComfyUI's `execution_error` event); the index signature keeps every other
 * field ComfyUI sends readable without pretending we know its type.
 */
export interface ComfyExecutionMessage {
  exception_message?: string
  exception_type?: string
  node_id?: string
  node_type?: string
  message?: string
  timestamp?: number
  [key: string]: unknown
}
