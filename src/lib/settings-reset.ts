import type { Settings } from '../types/settings'

/** Settings page top-level tabs. Kept here (UI-free) so the per-tab reset
 *  scope can be unit-tested without pulling the whole SettingsPage in. */
export type SettingsTab = 'general' | 'backends' | 'agent' | 'voice-remote'

// GitHub #59 — which settings keys each tab's reset restores.
// Only PREFERENCES are listed: user CONTENT (custom personas, memories,
// conversations, agent workflows, MCP server entries) is never touched by a
// settings reset — those have their own delete/clear flows with their own
// confirms. Voice lives in voiceStore (reset separately); Remote Access keeps
// only the phone's tab name (GitHub #19), the rest is runtime server state. onboardingDone is a
// lifecycle marker and is excluded everywhere (resetSettingsKeys also guards
// against it).
//
// Jaeger B, B10: every field a tab shows belongs to that tab's list. Think
// budget, the sub-agent limits, the /loop passes and a few switches were
// missing, so "Reset General" and "Reset Agent" left them standing; the test
// in __tests__/every-tab-field-is-reset.test.ts reads the fields from
// SettingsPage.tsx and checks them against this map.
export const SETTINGS_TAB_RESET_KEYS: Record<SettingsTab, (keyof Settings)[]> = {
  general: [
    'theme', 'userAvatarDataUrl',
    'temperature', 'topP', 'topK', 'maxTokens', 'thinkingBudget', 'contextWindowOverride',
    'emojiAutoReplace', 'enterKey', 'backgroundMediaTools', 'cloudTeasersEnabled',
    'autoCompact', 'autoCompactThreshold', 'attachmentTokenLimit',
    'gpuVendor', 'gpuIndices',
    'imageGenTimeoutMinutes', 'videoGenTimeoutMinutes', 'chatFirstReplyTimeoutSeconds',
  ],
  backends: ['apiEndpoint', 'hfDownloadPathOverride', 'downloadLimitMBps', 'exclusiveVramMode', 'builtinEngine', 'engineIdleUnloadMinutes'],
  agent: [
    'personasEnabled', 'defaultWorkspace',
    'agentMaxToolCalls', 'agentMaxIterations',
    'subAgentMaxToolCalls', 'subAgentMaxIterations', 'loopMaxPasses',
    'searchProvider', 'braveApiKey', 'tavilyApiKey', 'exaApiKey', 'searchUserAgent',
    'codexArchitectMode', 'codexArchitectModel', 'codexArchitectAllowCloud',
    'codexRepoMapEnabled', 'codexRepoMapLimit', 'codexAutoApply', 'codexReviewMode',
    'codexConfirmShell', 'codexCloudConfirmOptIn',
  ],
  'voice-remote': ['remotePageTitle', 'shareNewChatsWithPhone'],
}
