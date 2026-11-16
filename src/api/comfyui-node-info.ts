// The node catalogue of ComfyUI (/object_info), fetched once and cached.
// Split out of comfyui-nodes.ts (3.1.0) so comfy-split.ts can read it without
// the import cycle comfyui -> comfy-split -> comfyui-nodes -> comfyui.
// comfyui-nodes.ts re-exports getAllNodeInfo and the types.

import { comfyuiUrl, localFetch } from './backend'
import { log } from '../lib/logger'
import type { ComfyInputValue } from '../types/comfy-graph'

export interface NodeInputSpec {
  required: Record<string, ComfyInputValue>
  optional?: Record<string, ComfyInputValue>
}

export interface NodeMetadata {
  input: NodeInputSpec
  output: string[]
  output_tooltips?: string[]
  category?: string
  display_name?: string
  description?: string
}

// ─── Cache ───

let nodeInfoCache: Record<string, NodeMetadata> | null = null
let cacheTimestamp = 0
export const CACHE_TTL = 300_000 // 5 minutes

// ─── Fetch all node info (cached) ───

export async function getAllNodeInfo(forceRefresh = false): Promise<Record<string, NodeMetadata>> {
  if (!forceRefresh && nodeInfoCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return nodeInfoCache
  }

  // Bound this fetch. /object_info is the heaviest control-plane call (the full
  // node catalogue) and is the FIRST thing buildDynamicWorkflow hits. Without an
  // explicit cap it inherits the Rust proxy's 300 s default — and a single wedged
  // /object_info right after a ComfyUI (re)start froze the whole image-MCP VRAM
  // hand-off for minutes with the text model left unloaded (chat-agent hang,
  // 2026-06-03). 30 s is far beyond a healthy localhost response; on timeout we
  // throw a clean error so the hand-off's finally can free VRAM + reload the model.
  const res = await localFetch(comfyuiUrl('/object_info'), { timeoutMs: 30_000 })
  if (!res.ok) throw new Error(`Failed to fetch node info: ${res.status}`)
  const data = await res.json()

  nodeInfoCache = data
  cacheTimestamp = Date.now()
  log.info(`[comfyui-nodes] Loaded ${Object.keys(data).length} node types`)
  return data
}

/** Forgets the cached catalogue (comfyui-nodes' clearNodeCache). */
export function resetNodeInfo(): void {
  nodeInfoCache = null
  cacheTimestamp = 0
}

/** Whether the cached catalogue has this node; false before the first fetch. */
export function cachedNodeInfoHas(name: string): boolean {
  return nodeInfoCache ? name in nodeInfoCache : false
}
