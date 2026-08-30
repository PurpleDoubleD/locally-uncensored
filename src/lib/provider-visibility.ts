/**
 * Which provider rows Settings, AI Backends shows, and whether the chat picker
 * has any backend left to list.
 *
 * Nebenbefund 1 of the R9 re-measure on the 2.6.7 Windows build (2026-08-30):
 * the red "Disable" button on the LM Studio card removed the card from the
 * list. The list only ever rendered ENABLED providers, so the control that
 * turned a provider off also deleted the only place that could turn it back
 * on. What was left was LU Cloud, `activeModel` on null, and a chat picker
 * saying "No models available" with nothing to press.
 *
 * The rule here is small on purpose: a provider the USER switched off keeps
 * its row and shows an Enable button. A provider that is simply not in use
 * (a fresh install has Ollama and Anthropic off, and onboarding turns the
 * built-in engine off when the user picks Ollama) stays out of the list, so
 * the pane does not fill up with slots nobody asked for. That is what
 * `disabledByUser` marks, and only the Disable/Enable control writes it.
 */

export interface ProviderVisibilityConfig {
  enabled: boolean
  /** Set by the card's own Disable button, cleared by Enable. */
  disabledByUser?: boolean
}

/** Providers whose models never show in local mode, and are the only ones that
 *  show in cloud mode. */
const CLOUD_ONLY_IDS = ['lu-cloud']

/**
 * The rows the providers list renders, in store order: everything enabled,
 * plus everything the user switched off here.
 */
export function providerRowIds<T extends ProviderVisibilityConfig>(
  providers: Record<string, T | undefined>,
): string[] {
  return Object.keys(providers).filter((id) => {
    const p = providers[id]
    if (!p) return false
    return p.enabled || p.disabledByUser === true
  })
}

/** True for a row that is present but switched off, i.e. the Enable row. */
export function isReturnableRow<T extends ProviderVisibilityConfig>(config: T | undefined): boolean {
  return !!config && !config.enabled && config.disabledByUser === true
}

/**
 * No backend the CURRENT mode can use is enabled. Local mode never lists the
 * hosted models and cloud mode never lists the local ones, so "is anything
 * enabled" has to be asked per mode or the picker would claim a backend it
 * does not show.
 */
export function noChatBackendEnabled<T extends ProviderVisibilityConfig>(
  providers: Record<string, T | undefined>,
  appMode: 'local' | 'cloud',
): boolean {
  return !Object.keys(providers).some((id) => {
    const p = providers[id]
    if (!p?.enabled) return false
    const isCloudOnly = CLOUD_ONLY_IDS.includes(id)
    return appMode === 'cloud' ? isCloudOnly : !isCloudOnly
  })
}
