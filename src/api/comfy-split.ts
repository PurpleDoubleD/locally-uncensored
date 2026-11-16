/**
 * The live half of "One model across two cards" (3.1.0, C56): decide per
 * submit whether the running ComfyUI can take the split, and apply it. The
 * graph surgery itself is pure and lives in lib/comfy-split.ts.
 *
 * Nothing here may stop a render. Every failure, a missing node, a ComfyUI
 * that sees one card, an unreachable /system_stats, ends in "send the
 * workflow as it is", which is exactly what LU did before 3.1.0.
 */

import { comfyuiUrl, localFetch } from './backend'
import { log } from '../lib/logger'
import { useSettingsStore } from '../stores/settingsStore'
import { comfySplitOf } from '../lib/gpu-roles'
import {
  splitAcrossCards,
  comfySeesSplit,
  SELECT_CLIP_DEVICE,
  SELECT_VAE_DEVICE,
  SPLIT_HELPER_DEVICE,
} from '../lib/comfy-split'
import type { ComfyApiGraph } from '../types/comfy-graph'

const STATS_TIMEOUT_MS = 5_000

/** The workflow with the split applied when it is on and the running
 *  ComfyUI can do it; otherwise the workflow unchanged. */
export async function withComfySplit(workflow: ComfyApiGraph): Promise<ComfyApiGraph> {
  let split
  try {
    split = comfySplitOf(useSettingsStore.getState().settings.gpuRoles)
  } catch {
    return workflow
  }
  if (!split) return workflow
  try {
    const res = await localFetch(comfyuiUrl('/system_stats'), { timeoutMs: STATS_TIMEOUT_MS })
    if (!res.ok) return workflow
    const stats = await res.json()
    if (!comfySeesSplit(stats?.devices, split.model.name, split.helper.name)) {
      log.warn('comfyui.split_skipped', {
        reason: 'ComfyUI does not see the two cards in split order; restart ComfyUI to apply the setting',
        devices: Array.isArray(stats?.devices) ? stats.devices.map((d: { name?: unknown }) => String(d?.name ?? '')) : [],
      })
      return workflow
    }
    const { getAllNodeInfo } = await import('./comfyui-node-info')
    const info = await getAllNodeInfo()
    const clip = SELECT_CLIP_DEVICE in info
    const vae = SELECT_VAE_DEVICE in info
    if (!clip && !vae) {
      log.info('comfyui.split_skipped', { reason: 'this ComfyUI has no Select CLIP/VAE Device node (needs 0.23 or newer)' })
      return workflow
    }
    const out = splitAcrossCards(workflow, (cls) => info[cls]?.output, { clip, vae, device: SPLIT_HELPER_DEVICE })
    if (out.inserted.length > 0) {
      log.info('comfyui.split_applied', { device: SPLIT_HELPER_DEVICE, inserted: out.inserted })
    }
    return out.graph
  } catch (e) {
    log.warn('comfyui.split_skipped', { reason: String(e) })
    return workflow
  }
}
