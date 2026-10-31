/**
 * Does LM Studio's llama.cpp runtime load this model (N1, 30.10.2026).
 *
 * Liquid LFM3 needs LM Studio's llama.cpp runtime 2.65.1 or newer (model card
 * of LiquidAI/LFM3-1.7B-GGUF). The Mac this was written on had 2.55.0, where
 * the load fails without a word about why. LU reads the runtime LM Studio uses
 * (command lmstudio_gguf_runtime, read only) and says what to do before it
 * asks LM Studio for a load that cannot work. Unknown runtime: nothing said.
 */

export const LFM3_LMSTUDIO_RUNTIME = '2.65.1'

/** -1, 0 or 1 for two dotted versions, numbers compared part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function isLfm3Model(modelId: string): boolean {
  return /(^|[^a-z0-9])lfm3([^a-z0-9]|$)/i.test(modelId)
}

/** The sentence for an LFM3 model on a runtime that is too old, or null. */
export function lmStudioRuntimeNote(modelId: string, runtime: string | null | undefined): string | null {
  if (!isLfm3Model(modelId) || !runtime || !/^\d+(\.\d+)*$/.test(runtime)) return null
  if (compareVersions(runtime, LFM3_LMSTUDIO_RUNTIME) >= 0) return null
  return `Update LM Studio's runtime to ${LFM3_LMSTUDIO_RUNTIME} or newer for LFM3. LM Studio runs llama.cpp ${runtime}, which cannot load this model. In LM Studio: Settings, Runtime.`
}
