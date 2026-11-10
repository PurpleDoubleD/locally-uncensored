import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { Settings, Persona } from '../types/settings'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../lib/constants'
import { isEffortLevel } from '../lib/effort'
import { normalizeThinkBudget } from '../lib/think-budget'
import { isRecord, asString } from '../types/json-guards'
import { RETIRED_SEND_WINDOW_DEFAULT } from '../lib/send-window'
import { normalizeGpuRoles } from '../lib/gpu-roles'
import { storedTemperature } from '../lib/sampling'
// From the leaf, not api/backend: that one imports this store (madge).
import { isMacOS } from '../lib/device-kind'

// v5 (Feature EE v2.5.0): added settings.exclusiveVramMode. The migrate below
// already merges { ...DEFAULT_SETTINGS, ...persisted.settings }, so bumping the
// version is all that's needed — the new default fills in while every existing
// user value is preserved. Rehydration is NOT broken: a persisted v4 blob runs
// the same merge path that has handled every prior additive field.
// v6 (the web app design port): added settings.personasEnabled (master persona
// switch, default true). Bumped so existing users get the default ON instead
// of an undefined → falsy "personas off" surprise.
// v7 (Small-Model Mode v2.5.0): added settings.smallModelMode (lean profile
// for 3B-8B local models, default false). Same additive merge path below
// ({ ...DEFAULT_SETTINGS, ...persisted.settings }) fills the new default in
// while preserving every existing user value — existing users get it OFF.
// v8: added settings.userAvatarDataUrl (user profile picture, default ''),
// backfilled by the same additive merge — existing users keep the default icon.
// v9 (v2.5.3): added the model-picker preferences preferredImageModel /
// preferredVideoT2VModel / preferredVideoI2VModel (all default '' = "ask
// before the VRAM swap"). Same additive merge path — existing users simply
// see the picker on their next generation.
// v10 (2026-06-16): one-time RESET of those three picker preferences. Video had
// kept a silently-saved model and only offered "Change model"; the owner wants the
// full picker to come FIRST again on both image AND video. Clearing the saved
// picks once on upgrade makes the picker the default until the user deliberately
// saves a model again via the picker's Remember.
// v11 (2.5.7): added settings.appMode (global Local/Cloud switch, default
// 'local'). Same additive merge backfills it — without the bump, v10 blobs
// skip migrate entirely and the header ModeSwitch renders with appMode
// undefined, highlighting neither Local nor Cloud.
// v12 (2.5.7): added settings.comfyGpuMode ('auto'|'cpu'|'gpu', default
// 'auto') for the AMD ComfyUI GPU path (rhodium92). Additive — the merge
// fills the default while preserving every existing value; NVIDIA unaffected.
// v13 (2.5.7): added settings.cloudOnboardingSeen — REMOVED in 2.6.0: the
// one-time onboarding moved into the web checkout (#91); stale persisted
// values are ignored by the merge.
// v14 (2.5.8): added settings.cloudTeasersEnabled (Cloud discovery in Local
// mode: locked Create tabs + hosted-model picker rows, default true). Additive.
// v15 (2.5.9): added settings.codexCloudConfirmShell (default true). The cloud
// shell-confirm was hard-wired in useCodex, so the existing confirm toggle did
// nothing on a cloud model. Additive merge backfills the default — behaviour is
// byte-for-byte what 2.5.8 did until the user turns the new switch off.
// v16 (2.5.9): added settings.loopMaxPasses (default 0 = unlimited). Additive,
// but the bump is what makes the merge RUN — without it an existing profile
// keeps the field undefined and the Settings number box renders empty, which
// is how this was caught on the ship exe (2026-07-25). Behaviour was already
// correct via `?? 0`; this is so the UI shows the real value.
// v17 (2.5.10): added settings.codexAutoApply (default false) — auto-apply
// staged changes when the run finishes. Additive merge backfills the default;
// stage-mode behaviour is unchanged until the user turns the new switch on.
// v18 (2.6.0): added settings.builtinEngine (expert tuning for the bundled
// llama-server: ctx, flash attention, KV-cache quant, threads, GPU layers,
// mlock/mmap; defaults = the exact pre-2.6.0 argv). Additive merge backfills
// the default object; engine behaviour is unchanged until the user edits it.
// v19 (2.6.0): the macOS Cloud-only wall is lifted — the Mac app is a full
// local+cloud app again. Existing Mac installs were force-pinned to appMode
// 'cloud' with no real choice, so reset them to the local default ONCE so they
// land in the now-built local mode; the visible switch flips back anytime.
// Windows/Linux appMode reflects a real user choice and is never touched.
// v20 (2.6.6): added settings.contextDecay (default true) and
// settings.codexSendWindowTokens (default 64000) for the tool-result age decay,
// plus settings.memoryCloudOptIn (plan A7; the DEFAULT moved to true on
// 12.09.2026, this migration is untouched and stays purely additive) and
// settings.codexDefaultMode (default 'ask', plan C1); all four ride the
// default-merge, strictly additive, no one-shot reset (R1 downgrade contract)
// and the paid-provider send cap. STRICTLY ADDITIVE and IDEMPOTENT: the merge
// below fills both defaults in and preserves every existing value, and this
// version adds NO one-shot reset the way v10 and v19 did.
// That is a hard requirement, not a preference (plan R1, DOWNGRADE-KONTRAKT):
// the 2.6.5/2.6.6 A/B share one WebView profile, zustand stamps the OLD
// version back when the old build writes the store, so this migration runs
// AGAIN on the next 2.6.6 start. A one-shot reset here would fire on every
// build switch and quietly wipe a user preference each time.
// v21 (2.6.6): added settings.codexCloudConfirmOptIn (default false) and
// retired settings.codexCloudConfirmShell (default true). Bypass means bypass
// on a cloud model too (2026-08-22, replacing G15a of 2026-08-07), so
// the cloud shell confirm is an opt-in now.
// The key had to be a NEW one, not a flipped default on the old one: this
// store persists the whole settings object, so every existing profile has
// `codexCloudConfirmShell: true` written to disk, and a changed default alone
// would never reach it. Reusing the key would have meant a one-shot reset,
// which the R1 downgrade contract above rules out while 2.6.5 and 2.6.6 share
// one WebView profile. A new key rides the additive merge instead: the default
// fills in for everyone, an opt-in the user makes survives every A/B switch,
// and the stale old key is simply never read again. STRICTLY ADDITIVE and
// IDEMPOTENT, like v20 and unlike v10 and v19.
// v22 (2.6.8): added settings.reasoningEffort (default 'high'), the rung the
// composer's effort control cycles through. STRICTLY ADDITIVE and IDEMPOTENT
// like v20 and v21: the merge below fills the default in, every existing value
// survives, and there is NO one-shot reset. The default equals what the client
// already sent for thinking ON, so a profile that rides this migration sends
// byte-for-byte the same request it sent before.
// v23 (3.0.7): added settings.localEffortChosen (default false). Local
// servers take a rung since issue 176, and without this key the global 'high'
// would have gone to every local model nobody had touched. STRICTLY ADDITIVE
// and IDEMPOTENT like v20 to v22: the merge below fills false in for a profile
// that never had the key, and a true the user set survives every rerun of
// this migration after an A/B switch, because the merge keeps stored values.
const STORE_VERSION = 23

interface SettingsState {
  settings: Settings
  personas: Persona[]
  activePersonaId: string
  _version: number
  updateSettings: (partial: Partial<Settings>) => void
  resetSettings: () => void
  /** GitHub #59 — reset only the given settings keys to their defaults
   *  (per-section reset; leaves everything else untouched). */
  resetSettingsKeys: (keys: (keyof Settings)[]) => void
  addPersona: (persona: Persona) => void
  removePersona: (id: string) => void
  updatePersona: (id: string, partial: Partial<Persona>) => void
  setActivePersona: (id: string) => void
  getActivePersona: () => Persona | undefined
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      personas: BUILT_IN_PERSONAS,
      activePersonaId: 'unrestricted',
      _version: STORE_VERSION,

      updateSettings: (partial) =>
        set((state) => ({ settings: { ...state.settings, ...partial } })),

      resetSettings: () => set((state) => ({ settings: { ...DEFAULT_SETTINGS, onboardingDone: state.settings.onboardingDone } })),

      resetSettingsKeys: (keys) =>
        set((state) => {
          const next = { ...state.settings }
          for (const k of keys) {
            // onboardingDone is a lifecycle marker, not a preference — never
            // reset it (same guard the full resetSettings applies).
            if (k === 'onboardingDone') continue
            ;(next as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k]
          }
          return { settings: next }
        }),

      addPersona: (persona) =>
        set((state) => ({ personas: [...state.personas, persona] })),

      removePersona: (id) =>
        set((state) => ({
          personas: state.personas.filter((p) => p.id !== id),
          activePersonaId: state.activePersonaId === id ? 'unrestricted' : state.activePersonaId,
        })),

      updatePersona: (id, partial) =>
        set((state) => ({
          personas: state.personas.map((p) => (p.id === id ? { ...p, ...partial } : p)),
        })),

      setActivePersona: (id) => set({ activePersonaId: id }),

      getActivePersona: () => {
        const { personas, activePersonaId } = get()
        return personas.find((p) => p.id === activePersonaId)
      },
    }),
    {
      name: 'chat-settings',
      storage: safeJSONStorage(),
      version: STORE_VERSION,
      // The ONE guard for the rung, and it sits here rather than in migrate
      // above on purpose: migrate does not run for a blob that is already at
      // STORE_VERSION, where the persisted settings object is swapped in
      // wholesale. This runs on every rehydration, so it covers both, and a
      // second copy in migrate would be a guard no test can fail.
      //
      // reasoningEffort has a closed set of values. A profile written by a
      // build that spelled the rung differently, or edited by hand, would
      // otherwise travel through the whole app as an unknown word and the
      // composer would draw a rung the provider does not send. isEffortLevel is
      // the question, 'high' is the answer, and it is the answer a fresh
      // install gets.
      onRehydrateStorage: () => (state) => {
        if (!state?.settings) return
        if (!isEffortLevel(String(state.settings.reasoningEffort))) {
          state.settings.reasoningEffort = DEFAULT_SETTINGS.reasoningEffort
        }
        // Think budget (D12): a whole, non-negative count or 0. No version
        // bump, a profile without the key simply reads as auto.
        state.settings.thinkingBudget = normalizeThinkBudget(state.settings.thinkingBudget)
        // Local effort pick (v23): only a real true counts. A blob that is
        // already at this version but lacks the key reads as not picked.
        state.settings.localEffortChosen = state.settings.localEffortChosen === true
        // Emoticons to emojis (3.0.7): on unless switched off, so a profile
        // without the key gets the default.
        state.settings.emojiAutoReplace = state.settings.emojiAutoReplace !== false
        // Auto-compact is on by default since 3.0.7. Before, a 0 threshold was
        // the only way to be off and it was also what every profile that never
        // touched the setting held, so the stored 0 means "never chosen" and a
        // profile without the key is on. Only an explicit false stays off.
        state.settings.autoCompact = state.settings.autoCompact !== false
        // Chat Tools are always on since 3.0.7 (lib/chat-tools-reach.ts). The
        // old switch is gone, and so is what a profile kept of it, an "off"
        // included: nothing reads it, and it would only travel on unseen.
        delete (state.settings as unknown as Record<string, unknown>).chatToolsEnabled
        // A33 (3.0.8): the temperature sliders ran to 2.0 until 3.0.7, and a
        // profile that sat above TEMPERATURE_MAX made every model write noise.
        // Such a value goes back to the default, on the Settings page and in
        // every persona that carried its own, rather than to the ceiling:
        // 1.5 is still far from what the user had working before they moved it.
        state.settings.temperature = storedTemperature(state.settings.temperature) ?? DEFAULT_SETTINGS.temperature
        if (Array.isArray(state.personas)) {
          state.personas = state.personas.map((p) => {
            if (!p?.sampling || p.sampling.temperature === undefined) return p
            if (storedTemperature(p.sampling.temperature) !== undefined) return p
            const sampling = { ...p.sampling }
            delete sampling.temperature
            return { ...p, sampling }
          })
        }
        // REA plugin (3.0.7): only a real true starts a process.
        state.settings.reaPluginEnabled = state.settings.reaPluginEnabled === true
        // Neurons plugin (3.1.0): only a real true lets sliders steer.
        state.settings.neuronsPluginEnabled = state.settings.neuronsPluginEnabled === true
        // 3.0.8 (A2): background generations are on unless switched off, and
        // the card per service is read defensively, a hand-edited profile
        // must not send a half pick to the backend.
        state.settings.backgroundMediaTools = state.settings.backgroundMediaTools !== false
        state.settings.gpuRoles = normalizeGpuRoles(state.settings.gpuRoles)
        // 3.0.4 halved the paid-provider send window. A stored 64000 is the old
        // default (no UI writes this key), so it follows the new one. Here and
        // not in migrate for the same reason as above: no version bump, and a
        // downgrade simply reads the smaller number.
        if (state.settings.codexSendWindowTokens === RETIRED_SEND_WINDOW_DEFAULT) {
          state.settings.codexSendWindowTokens = DEFAULT_SETTINGS.codexSendWindowTokens
        }
        // A plain web search key on a phone moves into the keychain in the
        // boot of the phone (mobile/boot/index.tsx), not from here: the vault
        // reaches api/backend, which imports this store.
      },
      migrate: (persisted: unknown, version: number): SettingsState => {
        // Foreign at read time, an older build wrote this. A read that throws
        // in a migrate costs the whole store: zustand abandons hydration and
        // the next write persists the empty default over the blob, which here
        // would mean every setting AND every custom persona.
        const blob = isRecord(persisted) ? persisted : {}
        if (version < STORE_VERSION) {
          const storedPersonas = Array.isArray(blob.personas) ? blob.personas : []
          const customPersonas = storedPersonas.filter(
            (p): p is Persona => isRecord(p) && p.isBuiltIn !== true,
          )
          // Merge new default settings into existing (fills missing fields like thinkingEnabled)
          const storedSettings = isRecord(blob.settings) ? blob.settings : {}
          const mergedSettings = { ...DEFAULT_SETTINGS, ...storedSettings }
          // v10: clear the saved model-picker preferences ONCE so the picker is
          // shown first again on image + video (2026-06-16). The additive
          // merge above would otherwise preserve a previously-saved pick.
          if (version < 10) {
            mergedSettings.preferredImageModel = ''
            mergedSettings.preferredVideoT2VModel = ''
            mergedSettings.preferredVideoI2VModel = ''
          }
          // v19: release the Mac cloud lock (see the version log above).
          if (version < 19) {
            // A phone is not a Mac: the lock never existed there, and an old
            // phone profile in Cloud mode must not be thrown back to local.
            if (isMacOS()) mergedSettings.appMode = 'local'
          }
          return {
            ...blob,
            settings: mergedSettings,
            personas: [...BUILT_IN_PERSONAS, ...customPersonas],
            activePersonaId: asString(blob.activePersonaId) || 'unrestricted',
            _version: STORE_VERSION,
          } as unknown as SettingsState
        }
        // zustand types migrate as returning the FULL store, but a blob only
        // ever carries the partialized slice and `merge` puts the actions back.
        return persisted as SettingsState
      },
    }
  )
)
