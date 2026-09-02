/**
 * Docs-button state for the composer (A9).
 *
 * Local mode answers without asking anything, exactly as before. Cloud mode
 * probes the local embedding lane once per mount and reports what it found, so
 * the button can be there and say why it cannot run instead of being missing.
 */
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useRAGStore } from '../stores/ragStore'
import { embeddingBackendReady } from '../api/embed-availability'
import { docsAvailability, type DocsAvailability } from '../lib/docs-availability'

export function useDocsAvailability(): DocsAvailability {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  // `null` = not measured yet. Local mode never measures: the rule ignores the
  // probe there, and a Tauri round trip per composer mount for an answer nobody
  // reads is a cost with no buyer.
  const [embedReady, setEmbedReady] = useState<boolean | null>(null)

  useEffect(() => {
    if (appMode !== 'cloud') {
      setEmbedReady(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const ready = await embeddingBackendReady(useRAGStore.getState().embeddingModel)
        if (!cancelled) setEmbedReady(ready)
      } catch {
        // A probe that cannot run is not proof the lane is dead, but it is not
        // proof it lives either, and the honest report is the one the user can
        // act on: the tooltip names the missing part.
        if (!cancelled) setEmbedReady(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [appMode])

  return docsAvailability(appMode, embedReady)
}
