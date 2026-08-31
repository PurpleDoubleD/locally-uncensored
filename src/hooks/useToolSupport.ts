/**
 * The active model's tool-calling verdict, for the UI.
 *
 * Every surface that offers a tool control (the Chat Tools switch, the
 * per-category permission rows, the Agent toggle) needs the same answer, and
 * before 2.5.9 each computed its own version — so the Agent toggle could be
 * greyed out while the tool rows next to it stayed lit and silently produced
 * failing runs.
 */

import { useModelStore } from '../stores/modelStore'
import { resolveToolSupport, type ToolSupport } from '../lib/tool-support'

export interface ActiveToolSupport {
  support: ToolSupport
  /** False when tools cannot work with the current model at all. */
  canUseTools: boolean
  /** One short line to show next to a disabled control. Empty when enabled. */
  reason: string
  modelName: string | null
}

export function useToolSupport(): ActiveToolSupport {
  const activeModel = useModelStore((s) => s.activeModel)
  // Only the text variants of the AIModel union carry `supportsTools`; the
  // image/video rows have no such field, so the picker row is narrowed the
  // same way useCodex narrows it before asking toolStrategyFor.
  const supportsTools = useModelStore((s) => {
    const row = s.models.find((m) => m.name === s.activeModel)
    return row && row.type === 'text' ? row.supportsTools : undefined
  })

  if (!activeModel) {
    return { support: 'none', canUseTools: false, reason: 'Pick a model first.', modelName: null }
  }

  const support = resolveToolSupport({ name: activeModel, supportsTools })
  return {
    support,
    canUseTools: support !== 'none',
    reason: support === 'none' ? 'This model cannot call tools. Pick another one to use these.' : '',
    modelName: activeModel,
  }
}
