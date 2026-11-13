import { SETTINGS_TAB_RESET_KEYS, type SettingsTab } from './settings-reset'
import { useSettingsStore } from '../stores/settingsStore'
import { useVoiceStore } from '../stores/voiceStore'
import { usePermissionStore } from '../stores/permissionStore'
import { useProviderStore } from '../stores/providerStore'

/**
 * What the two reset buttons at the foot of every Settings tab do (GitHub
 * #59). One place for both, because they drifted: "Reset all settings" reset
 * the settings, the voice and the permissions, but not the AI Backends, while
 * "Reset AI Backends to defaults" did (Jaeger B, B2). The bigger button did
 * less than the smaller one, and a broken backend state stayed broken after
 * "everything" was reset.
 *
 * "all" is every tab's section reset at once, so anything a section reset
 * adds below is covered by "all" without a second line to remember. Content
 * is kept either way (personas, memories, conversations, workflows, MCP
 * servers), and the provider reset keeps API keys and the cloud account flag.
 */
export function runSettingsReset(scope: 'section' | 'all', tab: SettingsTab): void {
  if (scope === 'all') {
    useSettingsStore.getState().resetSettings()
    for (const t of Object.keys(SETTINGS_TAB_RESET_KEYS) as SettingsTab[]) resetSectionStores(t)
    return
  }
  useSettingsStore.getState().resetSettingsKeys(SETTINGS_TAB_RESET_KEYS[tab])
  resetSectionStores(tab)
}

/** The stores outside settingsStore that a tab's reset also restores. */
function resetSectionStores(tab: SettingsTab): void {
  if (tab === 'agent') usePermissionStore.getState().resetToDefaults()
  if (tab === 'voice-remote') useVoiceStore.getState().resetVoiceDefaults()
  // G20: "Reset AI Backends" only reset settings KEYS and never touched
  // the provider store, so it could not hand the openai slot back to the
  // Built-in Engine once LM Studio had adopted it. Now it restores the
  // shipped slots too (API keys and the cloud account flag are kept).
  if (tab === 'backends') useProviderStore.getState().resetProvidersToDefaults()
}
