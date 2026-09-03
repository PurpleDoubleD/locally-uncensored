/**
 * Shared readers for the ComfyUI-graph fixtures.
 *
 * Not a test file — the vitest include glob only matches names ending in
 * `.test.ts` — the same arrangement `provider-test-support.ts` uses.
 *
 * Four of these test files carried the identical three lines:
 *
 *   type WfNode = { class_type: string; inputs: Record<string, any> }
 *   const nodeOf = (wf: Record<string, any>, klass: string) => …
 *   const classTypes = (wf: Record<string, any>) => …
 *
 * A graph held as `Record<string, any>` reads exactly the same whether a field
 * is there or not: rename an input in the builder and `n.inputs.old_name`
 * quietly becomes `undefined`, which every `toBe(undefined)` and every
 * `not.toContain(…)` in the file happily agrees with. Held as the production
 * type the builders actually return — `ComfyApiGraph` — the same read stops
 * compiling.
 *
 * The one thing the fixtures need that `ComfyApiNode` does not promise is
 * `inputs`: it is optional there because a DOWNLOADED graph really can omit
 * it. These tests assert on graphs the app itself just built, so `nodeOf`
 * makes the missing case LOUD (a throw naming the node) instead of handing
 * back `undefined` — which a `toBeUndefined()` assertion two lines down would
 * have read as "the node is not in the graph".
 */

import {
  apiNodes,
  type ComfyApiGraph,
  type ComfyApiNode,
  type ComfyNodeInputs,
} from '../../types/comfy-graph'

/** A node of a freshly BUILT graph: `inputs` is present, so `n.inputs.x` reads. */
export interface BuiltNode extends ComfyApiNode {
  inputs: ComfyNodeInputs
}

function hasInputs(node: ComfyApiNode): node is BuiltNode {
  const inputs = node.inputs
  return typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs)
}

function requireInputs(id: string, node: ComfyApiNode): BuiltNode {
  if (!hasInputs(node)) {
    throw new Error(
      `graph node "${id}" (${node.class_type}) carries no inputs object — ` +
      'the builder produced a node this fixture cannot assert on',
    )
  }
  return node
}

/** Every `class_type` in the graph, junk keys skipped. */
export function classTypes(wf: ComfyApiGraph): string[] {
  return apiNodes(wf).map(([, n]) => n.class_type)
}

/**
 * The `[id, node]` of the FIRST node of this class, or `undefined` when the
 * graph has none — the shape `expect(nodeOf(wf, 'X')).toBeUndefined()` needs.
 * A node that IS there but carries no `inputs` throws instead.
 */
export function nodeOf(wf: ComfyApiGraph, klass: string): [string, BuiltNode] | undefined {
  const hit = apiNodes(wf).find(([, n]) => n.class_type === klass)
  if (!hit) return undefined
  return [hit[0], requireInputs(hit[0], hit[1])]
}

/** All `[id, node]` pairs of this class, in graph order. */
export function nodesOf(wf: ComfyApiGraph, klass: string): [string, BuiltNode][] {
  return apiNodes(wf)
    .filter(([, n]) => n.class_type === klass)
    .map(([id, n]) => [id, requireInputs(id, n)])
}

/** The node under this id, or `undefined` when the key holds something else. */
export function nodeAt(wf: ComfyApiGraph, id: string): BuiltNode | undefined {
  const hit = apiNodes(wf).find(([nodeId]) => nodeId === id)
  return hit ? requireInputs(hit[0], hit[1]) : undefined
}
