/**
 * Settings, General, Onboarding, "Re-run onboarding".
 *
 * The backend call clears the marker FILE, and the windows follow it: Rust
 * opens the wizard in its own small window and the main window waits hidden
 * until the marker is back (onboarding_window.rs). Without that window the
 * store flip below is what re-runs the wizard: AppShell gates it on
 * settings.onboardingDone, and that store is persisted, so it survives the
 * reload.
 *
 * Jaeger B, B6: the store used to flip in every case. Closing the wizard then
 * quit LU, and every later start forced the wizard again, because the store
 * backup said "not set up" too. Now, when the wizard has its own window, the
 * store stays onboardingDone: true. The wizard there does not read it; Rust
 * restores the marker when that window is closed during a re-run (`on_close`)
 * and the main window comes back, and a restart in the middle finds the
 * finished setup in the store backup (`decide_first_window`).
 *
 * Level (a): silent on purpose. The visible action succeeds either way, and
 * the reload wipes any message before it could be read.
 */
import { backendCall } from '../api/backend'
import { useSettingsStore } from '../stores/settingsStore'

export async function rerunOnboarding(reload: () => void = () => window.location.reload()): Promise<void> {
  try { await backendCall('set_onboarding_done', { done: false }) } catch { /* see above */ }
  const ownWindow = await backendCall<boolean>('onboarding_window_open').catch(() => false)
  if (ownWindow !== true) useSettingsStore.getState().updateSettings({ onboardingDone: false })
  reload()
}
