/**
 * "Update to X" in Settings and About, and the one short note at the start.
 * Only the open Android package has them (lib/app-update.ts).
 */
import { useEffect } from 'react'
import { checkForUpdate, shownUpdate, updateHintOffered, useAppUpdate, type AppUpdate } from '../../../lib/app-update'
import { mobileOS } from '../../../platform'
import { openAppLink } from '../../../policy/links'
import { SETTINGS_STRINGS } from '../../../strings/settings'
import { toast } from '../../../ui'
import { APP_VERSION } from './app-info'
import { storePolicy } from './policy'

const T = SETTINGS_STRINGS.about

const offered = () => updateHintOffered(storePolicy().preset, mobileOS())

export async function openUpdate(update: AppUpdate): Promise<void> {
  const result = await openAppLink(update.url)
  if (!result.opened) toast(T.updateFailed, { tone: 'error', testid: 'app-update-failed' })
}

/** Ask if a day has passed. */
export function useUpdateCheck(): void {
  useEffect(() => {
    if (offered()) void checkForUpdate()
  }, [])
}

/** Once at the start: ask, and say a new version once per version. */
export function useUpdateAtStart(): void {
  useEffect(() => {
    if (!offered()) return
    let gone = false
    void checkForUpdate().then(() => {
      if (gone) return
      const state = useAppUpdate.getState()
      const update = shownUpdate(state.latest, APP_VERSION)
      if (!update || state.announced === update.version) return
      state.set({ announced: update.version })
      toast(T.updateTo(update.version), { testid: 'app-update', action: { label: T.updateGet, onPress: () => void openUpdate(update) } })
    })
    return () => {
      gone = true
    }
  }, [])
}

/** The update to show in this build, or null. */
export function useShownUpdate(): AppUpdate | null {
  const latest = useAppUpdate((s) => s.latest)
  return offered() ? shownUpdate(latest, APP_VERSION) : null
}
