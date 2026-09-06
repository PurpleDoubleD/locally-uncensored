/**
 * What the user calls the app-managed llama-server sidecar.
 *
 * 2.6.8 (A14): it shipped as "Built-in Engine" from 2.5.7 on and is called
 * "LU Engine" from now on. Only the label moved. Every internal identifier
 * stays: the provider slot is still `openai`, the preset id is still
 * `builtin`, the Tauri commands are still `*_bundled_engine`.
 *
 * Two names therefore exist in the wild at once. The old one is written into
 * `lu-providers` on every machine that ran an earlier version, into the
 * `displaced` memory of the openai slot, and into chats that recorded which
 * backend answered. So the app WRITES the new name and READS both.
 */

/** The name written into every new provider config and model row. */
export const LU_ENGINE_NAME = 'LU Engine'

/** The name written by 2.5.7 through 2.6.7. Still on disk, never written again. */
export const LEGACY_ENGINE_NAME = 'Built-in Engine'

/**
 * True when a provider or model row names the app-managed engine, under
 * either its current or its former name.
 *
 * Substring, not equality: `bundledToAIModels` and the provider presets both
 * stamp the bare name, but a persisted row can carry a suffix, and the pre-2.6.8
 * matcher this replaces was a substring test too.
 */
export function isLuEngineName(name: string | null | undefined): boolean {
  const n = (name || '').toLowerCase()
  return n.includes('lu engine') || n.includes('built-in engine') || n.includes('built in engine')
}

/**
 * The same name with the old label swapped for the new one, for configs that
 * were persisted before the rename. Anything else is returned untouched, so a
 * backend the user named himself keeps his name.
 */
export function renameLegacyEngine<T extends { name?: string }>(config: T): T {
  if (!config || typeof config.name !== 'string') return config
  if (config.name.trim().toLowerCase() !== LEGACY_ENGINE_NAME.toLowerCase()) return config
  return { ...config, name: LU_ENGINE_NAME }
}
