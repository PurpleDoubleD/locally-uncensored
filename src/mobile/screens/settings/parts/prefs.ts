/**
 * Small preferences that only the phone has and no shared store carries:
 * the opt out of the anonymous switch counter (E17.1), whether the system
 * voice may stand in while Cloud is off (E11.5), the time of the last backup
 * the user asked for (E16.4), and the one time hint of E4.3.
 *
 * Kept in one persisted store under `lu-mobile-settings-prefs`, so a setting
 * survives a restart like every other one.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../../../../lib/storage-quota'

export interface SelfTestRecord {
  tokensPerSecond: number
  model: string
  at: number
}

export interface MobilePrefs {
  /** E17.1. Default on, as the desktop counts. */
  switchCounter: boolean
  /** E11.5. Default on: without it there is no voice at all while Cloud is off. */
  systemVoiceFallback: boolean
  /** Epoch ms of the last backup written on request or seen written, 0 when unknown. */
  lastBackupAt: number
  /** E4.3: the hint where to turn Cloud features back on was shown once. */
  teaserHintShown: boolean
  /** E19: the last engine self test that passed, for the row "Last speed". null: never. */
  lastSelfTest: SelfTestRecord | null
  /** GitHub #212: after a voice message to the computer the answer is read aloud. Default on. */
  remoteVoiceReadAloud: boolean
  setPref: <K extends keyof MobilePrefValues>(key: K, value: MobilePrefValues[K]) => void
}

export type MobilePrefValues = Pick<MobilePrefs, 'switchCounter' | 'systemVoiceFallback' | 'lastBackupAt' | 'teaserHintShown' | 'lastSelfTest' | 'remoteVoiceReadAloud'>

export const MOBILE_PREF_DEFAULTS: MobilePrefValues = {
  switchCounter: true,
  systemVoiceFallback: true,
  lastBackupAt: 0,
  teaserHintShown: false,
  lastSelfTest: null,
  remoteVoiceReadAloud: true,
}

export const useMobilePrefs = create<MobilePrefs>()(
  persist(
    (set) => ({
      ...MOBILE_PREF_DEFAULTS,
      setPref: (key, value) => set({ [key]: value } as Partial<MobilePrefs>),
    }),
    {
      name: 'lu-mobile-settings-prefs',
      storage: safeJSONStorage(),
      partialize: (s) => ({
        switchCounter: s.switchCounter,
        systemVoiceFallback: s.systemVoiceFallback,
        lastBackupAt: s.lastBackupAt,
        teaserHintShown: s.teaserHintShown,
        lastSelfTest: s.lastSelfTest,
        remoteVoiceReadAloud: s.remoteVoiceReadAloud,
      }),
    },
  ),
)
