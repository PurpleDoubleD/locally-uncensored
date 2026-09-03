import type { Settings } from '../types/settings'

/** Settings page top-level tabs. Kept here (UI-free) so the per-tab reset
 *  scope can be unit-tested without pulling the whole SettingsPage in. */
export type SettingsTab = 'general' | 'backends' | 'agent' | 'voice-remote'

// GitHub #59 (hussam) — which settings keys each tab's reset restores.
// Only PREFERENCES are listed: user CONTENT (custom personas, memories,
// conversations, agent workflows, MCP server entries) is never touched by a
// settings reset — those have their own delete/clear flows with their own
// confirms. Voice lives in voiceStore (reset separately); Remote Access has
// no persisted settings (runtime server state only). onboardingDone is a
// lifecycle marker and is excluded everywhere (resetSettingsKeys also guards
// against it).
export const SETTINGS_TAB_RESET_KEYS: Record<SettingsTab, (keyof Settings)[]> = {
  general: [
    'theme', 'userAvatarDataUrl',
    'temperature', 'topP', 'topK', 'maxTokens', 'contextWindowOverride',
    'autoCompactThreshold',
    'gpuVendor', 'gpuIndices',
    'imageGenTimeoutMinutes', 'videoGenTimeoutMinutes',
  ],
  backends: ['apiEndpoint', 'hfDownloadPathOverride', 'exclusiveVramMode', 'builtinEngine'],
  agent: [
    'personasEnabled', 'defaultWorkspace',
    'agentMaxToolCalls', 'agentMaxIterations',
    'searchProvider', 'braveApiKey', 'tavilyApiKey',
    'codexArchitectMode', 'codexArchitectModel', 'codexArchitectAllowCloud',
    'codexRepoMapEnabled', 'codexRepoMapLimit', 'codexStageMode', 'codexAutoApply', 'codexReviewMode',
  ],
  'voice-remote': [],
}
