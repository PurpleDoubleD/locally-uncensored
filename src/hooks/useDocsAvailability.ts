/**
 * Docs-button state for the composer (A9).
 *
 * Local mode answers without asking anything, exactly as before. Cloud mode
 * reads the shared lane measurement (useEmbedLane) so the button can be there
 * and say what is going on instead of being missing.
 */
import { useMemo } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useEmbedLane } from './useEmbedLane'
import { docsAvailability, type DocsAvailability } from '../lib/docs-availability'

export function useDocsAvailability(): DocsAvailability {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const info = useEmbedLane(appMode === 'cloud')
  // Memoised (review N1): this object is a prop on the button, and a fresh
  // identity on every keystroke in the composer is a re-render nobody asked for.
  return useMemo(() => docsAvailability(appMode, info), [appMode, info])
}
