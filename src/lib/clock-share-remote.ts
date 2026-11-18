// 3.1.2 (A39, GitHub #257): the remote server serves the phone page and the
// phone app a /config that says whether they may put the date and time into
// an agent prompt. The Rust side forgets the switch on every launch, so it is
// handed over at boot and on every change, including a Reset, the same way as
// the page title (lib/remote-page-title.ts).
import { backendCall, isTauri } from '../api/backend'
import { log } from './logger'
import { useSettingsStore } from '../stores/settingsStore'

export async function syncRemoteShareClock(share: boolean): Promise<void> {
  if (!isTauri()) return
  try {
    await backendCall('set_remote_share_clock', { share })
  } catch (err) {
    log.warn('remote_share_clock.sync_failed', { err })
  }
}

export function startRemoteShareClockSync(): Promise<void> {
  const shared = (s: ReturnType<typeof useSettingsStore.getState>) => s.settings.shareClockWithModel !== false
  useSettingsStore.subscribe((s, prev) => {
    if (shared(s) !== shared(prev)) void syncRemoteShareClock(shared(s))
  })
  return syncRemoteShareClock(shared(useSettingsStore.getState()))
}
