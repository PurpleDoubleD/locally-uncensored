/**
 * Smoke tests for the AppShell store backup triad (Bug #7 hotfix, 2026-04-19).
 *
 * Before the fix, chat history could be lost when an NSIS update killed the
 * app between backup intervals. The triad is:
 *   1. 10s safety-net interval (was 30s)
 *   2. chatStore.subscribe → debounced backup on any mutation
 *   3. beforeunload sync flush for graceful quits
 *
 * These tests read the source so we catch accidental regressions that would
 * quietly revert any of the three.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const src = readFileSync(join(__dirname, '../AppShell.tsx'), 'utf8')

describe('AppShell backup triad (Bug #7)', () => {
  it('runs the safety-net interval every 5 seconds (tighter than 30s for crash recovery)', () => {
    expect(src).toContain('setInterval(doBackup, 5_000)')
    // Make sure the old 30s value is really gone.
    expect(src).not.toContain('setInterval(doBackup, 30_000)')
  })

  it('subscribes to chatStore for event-driven backup', () => {
    expect(src).toContain('useChatStore.subscribe')
    expect(src).toContain('scheduleBackup')
  })

  it('debounces event-driven backups with a setTimeout to coalesce bursts', () => {
    expect(src).toContain('debounceTimer')
    expect(src).toMatch(/setTimeout\(doBackup,\s*1_?000\)/)
  })

  it('flushes a final backup on beforeunload (graceful quit)', () => {
    expect(src).toContain("addEventListener('beforeunload'")
    expect(src).toContain('onBeforeUnload')
  })

  it('beforeunload flush is synchronous — never awaits IndexedDB during teardown', () => {
    // doBackup awaits idbStorage reads; an await inside beforeunload means the
    // trailing backup_stores invoke may never fire. The handler must call the
    // sync snapshot (localStorage + the idb write mirror) instead of doBackup.
    // The snapshot builder moved into lib/store-backup in 2.6.8 so the update
    // path could reach it; the guarantee is unchanged, only its name is.
    expect(src).toContain('flushSyncStoreBackup()')
    expect(src).toMatch(/const onBeforeUnload = \(\) => \{[^}]*flushSyncStoreBackup\(\)/s)
    expect(src).not.toMatch(/const onBeforeUnload = \(\) => \{[^}]*void doBackup\(\)/s)
  })

  it('restore writes IDB-backed keys through idbStorage, not localStorage (quota)', () => {
    // The chat blob can exceed the ~5 MB localStorage quota — a raw
    // localStorage.setItem would throw QuotaExceededError and abort the whole
    // restore on exactly the post-NSIS boot it exists to protect.
    expect(src).toContain('idbStorage.setItem(key, value)')
  })

  it('cleans up all three hooks in the useEffect return', () => {
    // Regression guard: the return() block must clear interval, debounce,
    // subscription, and event listener.
    expect(src).toContain('clearInterval(interval)')
    expect(src).toContain('unsubChat()')
    expect(src).toContain("removeEventListener('beforeunload'")
    expect(src).toContain('clearTimeout(debounceTimer)')
  })

  it('includes a __ts timestamp marker so a fresh install still writes a backup', () => {
    // The `__ts` marker is what makes the snapshot non-empty when no store has
    // persisted yet, so a fresh install still writes a file whose mtime says
    // when the app last ran.
    //
    // The original claim here was "we intentionally write UNCONDITIONALLY".
    // That claim is retired: writing every 5 s regardless of whether anything
    // changed was multi-megabyte SSD churn and GC pressure on an idle app. The
    // triad now writes only on a change (backupStoresIfChanged), and the first
    // write of a session always happens because nothing is on disk to compare
    // against — see store-backup-dirty.test.ts.
    const backup = readFileSync(join(__dirname, '../../../lib/store-backup.ts'), 'utf8')
    expect(backup).toContain('__ts')
    expect(backup).toContain('new Date().toISOString()')
  })

  it('onboarding-marker migration does NOT re-write the marker when user clicked Settings -> Re-run onboarding', () => {
    // Regression for v2.4.0 E2E: the Re-run onboarding button deletes the
    // marker + sets settings.onboardingDone=false + reloads. AppShell mount
    // must NOT re-create the marker just because it is missing — otherwise
    // the user is sent straight back into the main app instead of the wizard.
    // The migration is gated on settings.onboardingDone === true so it only
    // fires for legitimate NSIS-update-after-onboarding scenarios.
    expect(src).toMatch(/useSettingsStore\.getState\(\)\.settings\.onboardingDone/)
    // The gated form must appear somewhere inside the is_onboarding_done.then block
    expect(src).toMatch(/if \(!markerExists && useSettingsStore\.getState\(\)\.settings\.onboardingDone\)/)
  })
})
