import type { ProviderModel } from '../api/providers/types'
import type { CloudModel } from '../types/models'
import { prefixModelName } from '../api/providers/registry'

/**
 * One catalogue entry, as the model store keeps it.
 *
 * This lived inline in useModels as an object literal that rebuilt the row
 * field by field. Twice now a field has died in a literal of exactly this
 * shape: Ollama's per-model tool answer in 2026-08 (the comment above the
 * Ollama branch in useModels still carries that story), and the whole server
 * catalogue on a LAN cloud base in 2026-09. Extracted so there is ONE place
 * that decides what a model row carries, and so a test can drive the real path
 * from an HTTP response to the composer without going through the hook.
 */
export function cloudModelRow(pm: ProviderModel): CloudModel {
  return {
    name: prefixModelName(pm.provider, pm.id),
    model: pm.id,
    size: 0,
    type: 'text',
    provider: pm.provider,
    providerName: pm.providerName,
    contextLength: pm.contextLength,
    supportsTools: pm.supportsTools,
    supportsVision: pm.supportsVision,
    thinkMode: pm.thinkMode,
    effortLevels: pm.effortLevels,
    effortDefault: pm.effortDefault,
    // Friendly server label (LU Cloud). Pickers prefer it over the raw id.
    displayName: pm.name !== pm.id ? pm.name : undefined,
  }
}
