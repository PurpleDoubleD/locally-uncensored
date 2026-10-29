/**
 * Provider Store, manages provider configurations.
 *
 * Stores endpoint URLs, API keys (encrypted), and enabled state.
 * Ollama is always enabled by default.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { CompatProviderId, FixedProviderId, ProviderId, ProviderConfig } from '../api/providers/types'
import { compatProviderId, isCompatProviderId } from '../api/providers/compat-id'
import { clearProviderCache } from '../api/providers/client-cache'
import { onLocalSlotChanged } from '../lib/builtin-slot-eviction'
import { LU_ENGINE_NAME, renameLegacyEngine } from '../lib/engine-name'
import { announceDarkenedSlots } from '../lib/provider-slot-darkening'
import { honourUserDisable } from '../lib/provider-visibility'
import { secretGet, secretSet, secretDelete, secretParkGet, secretParkSet, secretParkDelete, setOllamaBase } from '../api/backend'
import { isOpenAIEntryId, OPENAI_ENTRY_PREFIX } from '../api/providers/model-name'
import { CLOUD_BASE } from '../api/cloud/config'

// ── API Key storage ────────────────────────────────────────────
// Two-tier (H5):
//   • Windows + macOS desktop → the real key lives in the OS credential vault
//     (Credential Manager / Keychain) via the Rust secret_* commands.
//     `keychainReady` flips true once hydrateProviderKeys confirms the vault
//     works; partialize then keeps the key out of localStorage entirely.
//   • Linux desktop + the web build → no robust uniform vault, so the key stays
//     in localStorage under the base64 obfuscation below (unchanged behavior).
// In-memory we always hold the OBFUSCATED form so the sync getters
// (getProviderApiKey / getEnabledProviders) are identical on every platform.

function obfuscate(key: string): string {
  if (!key) return ''
  try {
    return btoa(key.split('').reverse().join(''))
  } catch {
    return key
  }
}

// Exported for ProviderConfig.tsx's handback/removal paths (Opus-Review
// Nachbesserung 6): `displaced.apiKey` carries the same obfuscated form this
// function decodes for every other read of a provider's key, and restoring
// it into the active slot has to go through `setProviderApiKey` (store AND
// keychain), which takes the PLAIN key.
export function deobfuscate(encoded: string): string {
  if (!encoded) return ''
  try {
    return atob(encoded).split('').reverse().join('')
  } catch {
    return encoded
  }
}

// Flipped true by hydrateProviderKeys when the OS keychain is usable on this
// platform. Until then (and forever on Linux/web) the store behaves exactly as
// before. Module-level so the static `partialize` can read it.
let keychainReady = false
const PROVIDER_IDS: ProviderId[] = ['ollama', 'openai', 'anthropic']

// ── Vault access per slot ──────────────────────────────────────
// The four fixed slots have a fixed vault entry each (secret_*). An extra
// OpenAI-compatible slot (`openai-<slug>`, api/providers/compat-id.ts) is not
// on that list, so its key goes to the parked namespace of the same vault
// (secret_park_*), which takes any slug of [a-z0-9-]{1,64}. The `slot-`
// prefix keeps these entries apart from the keys lib/parked-key.ts parks
// there under a backend's display name, and which it deletes on restore.
function parkedAccount(id: CompatProviderId): string {
  return `slot-${id}`
}
function vaultGet(id: ProviderId): Promise<string | null> {
  return isCompatProviderId(id) ? secretParkGet(parkedAccount(id)) : secretGet(id)
}
function vaultSet(id: ProviderId, key: string): Promise<void> {
  return isCompatProviderId(id) ? secretParkSet(parkedAccount(id), key) : secretSet(id, key)
}
function vaultDelete(id: ProviderId): Promise<void> {
  return isCompatProviderId(id) ? secretParkDelete(parkedAccount(id)) : secretDelete(id)
}

/**
 * What an extra slot may carry when it comes out of storage. A blob is text
 * somebody could have edited, and this entry decides where a saved API key
 * is sent, so nothing is taken over that was not checked: the id is the map
 * key, the address must be http or https, and the fields that belong to the
 * shared slot alone (`managed`, `displaced`) never survive.
 */
function sanitizeCompatSlot(id: CompatProviderId, raw: unknown): ProviderConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ProviderConfig>
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : ''
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return null
  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 80) : id,
    enabled: r.enabled === true && !!baseUrl,
    baseUrl,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
    isLocal: r.isLocal === true,
  }
}
// Providers whose OS-vault WRITE failed this session. partialize keeps their
// obfuscated key in localStorage as a fallback so a flaky/locked credential
// store can't silently drop the key on the next restart.
const _keychainFailed = new Set<ProviderId>()
// The same, per additional OpenAI-compatible entry (GitHub #173).
const _entryKeychainFailed = new Set<string>()

// ── Default provider configs ───────────────────────────────────

// 2.5.7, the default backend is now the app's built-in engine (bundled
// llama-server, managed lifecycle) so a fresh install can chat without
// installing Ollama/LM Studio. It occupies the `openai` slot (OpenAI-compatible)
// with `managed: true`. Ollama/LM Studio stay available as "Advanced", the user
// can re-enable them from Settings → Providers. This default only applies to a
// FRESH store; existing `lu-providers` persistence is untouched.
const DEFAULT_PROVIDERS: Record<FixedProviderId, ProviderConfig> = {
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    enabled: false,
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    isLocal: true,
  },
  openai: {
    id: 'openai',
    name: LU_ENGINE_NAME,
    enabled: true,
    baseUrl: 'http://127.0.0.1:8127/v1',
    apiKey: '',
    isLocal: true,
    managed: true,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    enabled: false,
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    isLocal: false,
  },
  // LU Cloud chat (lu-labs.ai inference proxy). apiKey stays empty forever,
  // auth is the user's Supabase session token, injected per request by
  // LuCloudProvider. useCloudAuth flips `enabled` with the account state.
  'lu-cloud': {
    id: 'lu-cloud',
    name: 'LU Cloud',
    enabled: false,
    baseUrl: `${CLOUD_BASE}/api/inference/v1`,
    apiKey: '',
    isLocal: false,
  },
}

/**
 * The model/provider invariant, asked on EVERY path that can switch a slot off.
 *
 * A slot going dark makes the picked model unservable, and nothing used to
 * notice: the pick is only re-validated against the next NON-EMPTY model list,
 * so until a refresh lands the composer offers a model whose backend is off and
 * every send fails with model-not-found.
 *
 * It hung off `setProviderConfig` alone, which is only the explicit toggle.
 * `resetProvidersToDefaults` ("Reset AI Backends", a button in Settings) writes
 * DEFAULT_PROVIDERS over the whole map, where Ollama and Anthropic default to
 * `enabled: false`, so a user whose pick was an Ollama model reached exactly
 * the same broken state through a supported, one-click, non-exotic path.
 * `resetProvider` does the same for one slot.
 *
 * Audit W-T2: hier stand `void import('./modelStore')` mit der Begruendung
 * "modelStore reaches back here through chatStore/remoteStore, and a static
 * edge would close that circle at module-init time". Die Begruendung stimmte,
 * die Aufloesung nicht: der dynamische Import hat den Kreis nicht geoeffnet,
 * sondern nur unsichtbar gemacht (providerStore -> modelStore -> engine ->
 * providerStore, und providerStore -> modelStore -> chatStore -> remoteStore
 * -> providerStore).
 *
 * Dieser Store hat kein Geschaeft damit, den Modell-Store zu kennen. Er weiss
 * nur, welche Slots gerade dunkel geworden sind, und sagt es an. Wer darauf
 * reagieren will, meldet sich an; die Leitung dazwischen steht in
 * lib/provider-slot-darkening.ts, gehoert keinem der beiden Stores und
 * schliesst damit keinen Kreis.
 */
function dropPicksForDarkenedSlots(
  before: Partial<Record<ProviderId, ProviderConfig>>,
  after: Partial<Record<ProviderId, ProviderConfig>>,
): void {
  const darkened = (Object.keys(after) as ProviderId[]).filter(
    (id) => before[id]?.enabled === true && after[id]?.enabled === false,
  )
  if (darkened.length === 0) return
  // Die Zustellung liegt eine Mikrotask hinter diesem Aufruf, also wird dort
  // noch einmal gefragt statt hier eingefroren. Sonst raeumt ein Slot, der in
  // derselben Runde wieder eingeschaltet wird, eine Wahl, die er weiterhin
  // bedient: resetProvidersToDefaults() schaltet Ollama aus (Voreinstellung),
  // und der naechste setProviderConfig('ollama', { enabled: true }) direkt
  // danach wieder an. Genau diese Runde laeuft im Onboarding.
  announceDarkenedSlots(() =>
    darkened.filter((id) => useProviderStore.getState().providers[id]?.enabled === false),
  )
}

/**
 * GitHub #173: the same invariant for the additional OpenAI-compatible
 * entries. An entry that goes dark (switched off, removed) makes every pick
 * named `openai:<entry>::...` unservable; the key announced is that prefix,
 * which is what `modelBackendKey` answers for such a pick.
 */
function dropPicksForDarkenedEntries(before: ProviderConfig[], after: ProviderConfig[]): void {
  const darkened = before
    .filter((b) => b.enabled && b.entryId && !after.some((a) => a.entryId === b.entryId && a.enabled))
    .map((b) => b.entryId as string)
  if (darkened.length === 0) return
  announceDarkenedSlots(() =>
    darkened
      .filter((id) => !useProviderStore.getState().openaiEntries.some((e) => e.entryId === id && e.enabled))
      .map((id) => `${OPENAI_ENTRY_PREFIX}${id}` as const),
  )
}

/** Keychain account (the parked namespace, slug only) of an entry's key. */
function entryKeyAccount(entryId: string): string {
  return `entry-${entryId}`
}

/** A fresh entry id: a slug from the backend's name plus four random hex. */
function newEntryId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'backend'
  for (let i = 0; i < 50; i++) {
    const rnd = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
    const id = `${base}-${rnd}`
    if (isOpenAIEntryId(id) && !taken.includes(id)) return id
  }
  return `backend-${Date.now().toString(16)}`
}

/**
 * One persisted entry, made safe to use. Anything that is not an object with
 * a valid, unused id is dropped; the fields the four fixed slots own
 * (`managed`, `displaced`) never ride on an entry, because the app manages no
 * entry's lifecycle and an entry pushes nobody out.
 */
export function sanitizeOpenAIEntries(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderConfig[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const r = e as Partial<ProviderConfig>
    if (!isOpenAIEntryId(r.entryId) || out.some((o) => o.entryId === r.entryId)) continue
    out.push({
      id: 'openai',
      entryId: r.entryId,
      name: typeof r.name === 'string' && r.name.trim() ? r.name : 'OpenAI compatible',
      enabled: r.enabled === true,
      baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : '',
      apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
      isLocal: r.isLocal === true,
      ...(r.disabledByUser === true ? { disabledByUser: true } : {}),
    })
  }
  return out
}

/**
 * The persisted shape, from any older version to the current one.
 *
 * Version 2 (3.0.7, GitHub #173) adds `openaiEntries`, the OpenAI-compatible
 * backends that run NEXT TO the `openai` slot. A version 1 blob has none, so
 * it gets an empty list, and every model id it ever stored (`openai::<model>`)
 * keeps pointing at the slot it always pointed at. Nothing else changes, which
 * is also why an older build reading a version 2 blob keeps every backend: its
 * migrate is the identity and it simply ignores the new key.
 */
export function migrateProviderState(persisted: unknown, version: number): unknown {
  const p = (persisted && typeof persisted === 'object' ? { ...(persisted as Record<string, unknown>) } : {})
  if (version < 2) {
    p.openaiEntries = sanitizeOpenAIEntries(p.openaiEntries)
  }
  return p
}

// ── Store Interface ────────────────────────────────────────────

interface ProviderState {
  providers: Record<ProviderId, ProviderConfig>
  /** Persisted: user opted out of the multi-backend selector modal. When true,
   * AppShell never re-shows the modal on startup even if multiple backends are
   * running. User can still add / remove providers via Settings → Providers. */
  hideBackendSelector: boolean
  /**
   * Persisted: the customer picked a different local backend for the `openai`
   * slot ON PURPOSE, through one of the dedicated pick UIs (onboarding's
   * backend step, the startup backend selector, "Start LM Studio Server" in
   * the model picker), not through Add Provider taking the slot from LU
   * Engine. Opus review, R13D Nebenfund 1 follow-up (2026-09-21): the missing
   *-engine notice (lib/builtin-engine-presence.ts) must not fire for a
   * customer who never had, or never wanted, LU Engine in the first place.
   * Those pick UIs write `managed: false` with no `displaced` record, the
   * exact same shape the silent-eviction bug leaves behind, so the provider
   * config alone cannot tell the two apart; this flag is the difference.
   * Reset to false automatically the moment `managed: true` is written back
   * onto the `openai` slot (Built-in chosen again, Restore, or a full Reset),
   * so a LATER real eviction is still caught.
   */
  engineOptedOut: boolean
  /**
   * GitHub #173: additional OpenAI-compatible backends, each with its own
   * address, key and model list, running NEXT TO the `openai` slot instead of
   * taking it over. Every entry carries `id: 'openai'` and its own `entryId`;
   * its models are `openai:<entryId>::<model>`. The `openai` slot itself stays
   * where it was, so every stored `openai::<model>` keeps meaning what it meant.
   */
  openaiEntries: ProviderConfig[]

  /** Adds an entry and returns its id. Enabled right away. */
  addOpenAIEntry: (input: { name: string; baseUrl: string; isLocal: boolean }) => string
  updateOpenAIEntry: (entryId: string, updates: Partial<Pick<ProviderConfig, 'name' | 'baseUrl' | 'isLocal' | 'enabled' | 'disabledByUser'>>) => void
  setOpenAIEntryApiKey: (entryId: string, key: string) => void
  getOpenAIEntryApiKey: (entryId: string) => string
  removeOpenAIEntry: (entryId: string) => void

  setProviderConfig: (id: ProviderId, updates: Partial<ProviderConfig>) => void
  setProviderApiKey: (id: ProviderId, key: string) => void
  getProviderApiKey: (id: ProviderId) => string
  getEnabledProviders: () => ProviderConfig[]
  resetProvider: (id: ProviderId) => void
  /** G20: restore EVERY slot to the shipped defaults (Built-in Engine back on
   * the openai slot). "Reset AI Backends" never touched this store, so a user
   * whose slot was adopted by LM Studio had no way back to the bundled engine.
   * Keeps stored API keys and the LU Cloud enabled flag: keys are data, and
   * cloud-enabled is account state owned by useCloudAuth, not backend config. */
  resetProvidersToDefaults: () => void
  /**
   * Creates an extra OpenAI-compatible slot, or updates name and address of
   * the one that already has this slug. Returns its id (`openai-<slug>`), or
   * null when the slug or the address is not usable. A new slot starts
   * switched off and without a key. The shared `openai` slot is never
   * touched, so on a phone the on device engine keeps its place.
   */
  addCompatProvider: (input: { slug: string; name: string; baseUrl: string; isLocal?: boolean }) => CompatProviderId | null
  /** Removes an extra slot together with its key. A fixed slot is ignored. */
  removeCompatProvider: (id: ProviderId) => void
  setHideBackendSelector: (hide: boolean) => void
  /** Marks (or clears) the deliberate opt-out above. The five pick UIs call
   *  this with `true`; nothing else needs to call it with `false`, since
   *  `setProviderConfig` clears it on its own the moment LU Engine is back. */
  setEngineOptedOut: (optedOut: boolean) => void
  /** H5: load provider keys from the OS keychain (Win/macOS), migrating any
   * existing localStorage key into the vault. No-op / fallback elsewhere.
   * Call once at app startup, before the first provider client is built. */
  hydrateProviderKeys: () => Promise<void>
}

// ── Zustand Store ──────────────────────────────────────────────

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      providers: DEFAULT_PROVIDERS,
      hideBackendSelector: false,
      engineOptedOut: false,
      openaiEntries: [],

      addOpenAIEntry: ({ name, baseUrl, isLocal }) => {
        const entryId = newEntryId(name, get().openaiEntries.map((e) => e.entryId as string))
        set((s) => ({
          openaiEntries: [
            ...s.openaiEntries,
            { id: 'openai', entryId, name, baseUrl, isLocal, enabled: true, apiKey: '' },
          ],
        }))
        clearProviderCache()
        return entryId
      },

      updateOpenAIEntry: (entryId, updates) => {
        const before = get().openaiEntries
        set((s) => ({
          openaiEntries: s.openaiEntries.map((e) => (e.entryId === entryId ? { ...e, ...updates } : e)),
        }))
        clearProviderCache()
        dropPicksForDarkenedEntries(before, get().openaiEntries)
      },

      setOpenAIEntryApiKey: (entryId, key) => {
        set((s) => ({
          openaiEntries: s.openaiEntries.map((e) => (e.entryId === entryId ? { ...e, apiKey: obfuscate(key) } : e)),
        }))
        // Same two tiers as the slots: the vault when it works, the obfuscated
        // localStorage copy when the write fails or there is no vault.
        if (keychainReady) {
          _entryKeychainFailed.delete(entryId)
          secretParkSet(entryKeyAccount(entryId), key).catch(() => {
            _entryKeychainFailed.add(entryId)
            set((s) => ({ openaiEntries: [...s.openaiEntries] }))
          })
        }
        clearProviderCache()
      },

      getOpenAIEntryApiKey: (entryId) => {
        return deobfuscate(get().openaiEntries.find((e) => e.entryId === entryId)?.apiKey || '')
      },

      removeOpenAIEntry: (entryId) => {
        const before = get().openaiEntries
        set((s) => ({ openaiEntries: s.openaiEntries.filter((e) => e.entryId !== entryId) }))
        if (keychainReady) {
          void secretParkDelete(entryKeyAccount(entryId)).catch(() => { /* best-effort */ })
        }
        _entryKeychainFailed.delete(entryId)
        clearProviderCache()
        dropPicksForDarkenedEntries(before, get().openaiEntries)
      },

      setHideBackendSelector: (hide) => set({ hideBackendSelector: hide }),
      setEngineOptedOut: (optedOut) => set({ engineOptedOut: optedOut }),

      addCompatProvider: ({ slug, name, baseUrl, isLocal }) => {
        const id = compatProviderId(slug)
        if (!id) return null
        const existing = get().providers[id]
        const next = sanitizeCompatSlot(id, {
          ...existing,
          name,
          baseUrl,
          isLocal: isLocal === true,
        })
        if (!next) return null
        // A changed address with the old key still attached would send that
        // key to the new host on the next request. The key was typed for the
        // old address, so it goes with it.
        const moved = !!existing && !!existing.baseUrl && existing.baseUrl !== next.baseUrl
        if (moved) {
          next.apiKey = ''
          next.enabled = false
          if (keychainReady) void vaultDelete(id).catch(() => { /* best effort */ })
        }
        set((state) => ({ providers: { ...state.providers, [id]: next } }))
        clearProviderCache()
        if (moved && existing.enabled) {
          announceDarkenedSlots(() => (get().providers[id]?.enabled ? [] : [id]))
        }
        return id
      },

      removeCompatProvider: (id) => {
        if (!isCompatProviderId(id)) return
        const before = get().providers[id]
        if (!before) return
        set((state) => {
          const providers = { ...state.providers }
          delete providers[id]
          return { providers }
        })
        _keychainFailed.delete(id)
        if (keychainReady) void vaultDelete(id).catch(() => { /* vault delete best-effort */ })
        clearProviderCache()
        // A pick served by this slot is unservable from here on.
        if (before.enabled) {
          announceDarkenedSlots(() => (get().providers[id]?.enabled ? [] : [id]))
        }
      },

      setProviderConfig: (id, updates) => {
        const before = get().providers[id]
        // An extra slot exists only once addCompatProvider made it. Writing
        // into one that is not there would create a half entry without an
        // address.
        if (!before && isCompatProviderId(id)) return
        if (before && isCompatProviderId(id)) {
          // The fields of the shared slot have no meaning here, and the id is
          // the map key. An address change goes through addCompatProvider,
          // which also drops the key typed for the old host.
          const { enabled, name, disabledByUser } = updates
          const patch: Partial<ProviderConfig> = {}
          if (enabled !== undefined) patch.enabled = enabled && !!before.baseUrl
          if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 80)
          if (disabledByUser !== undefined) patch.disabledByUser = disabledByUser
          set((state) => ({ providers: { ...state.providers, [id]: { ...before, ...patch } } }))
          clearProviderCache()
          dropPicksForDarkenedSlots({ [id]: before }, { [id]: get().providers[id] })
          return
        }
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: { ...state.providers[id], ...updates },
          },
        }))
        clearProviderCache() // invalidate cached clients
        dropPicksForDarkenedSlots({ [id]: before }, { [id]: get().providers[id] })
        // LU Engine is back on the slot on purpose (Built-in chosen again,
        // Restore, a full Reset): whatever opt-out was recorded no longer
        // describes the customer's current choice, so a LATER real eviction
        // is not silently swallowed by a stale flag. Ordered before the
        // onLocalSlotChanged call below on purpose (the two do not depend on
        // each other), so that call stays the LAST statement this function
        // makes, the shape displaced-engine-frees-its-memory.test.ts pins for
        // every write path that touches the shared slot.
        if (id === 'openai' && updates.managed === true && get().engineOptedOut) {
          set({ engineOptedOut: false })
        }
        // Every route that moves the shared local slot comes through here (Add
        // Provider, Enable on the standby card, Remove, Disable, onboarding), so
        // the memory question is asked here, once. R12/R13 measured the answer
        // it used to get: Jan takes the slot, lu-llama-server keeps PID and
        // model in RAM until the app is restarted. See lib/builtin-slot-eviction.
        if (id === 'openai') onLocalSlotChanged(before, get().providers.openai)
      },

      setProviderApiKey: (id, key) => {
        if (isCompatProviderId(id) && !get().providers[id]) return
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: { ...state.providers[id], apiKey: obfuscate(key) },
          },
        }))
        // When the OS vault is active, store the real key there; partialize then
        // keeps it out of localStorage. If the vault WRITE fails (locked / policy
        // / full), mark this id so partialize RETAINS the obfuscated key in
        // localStorage, otherwise it would vanish on the next restart with no
        // trace (the in-memory value only serves this session).
        if (keychainReady) {
          _keychainFailed.delete(id)
          vaultSet(id, key).catch(() => {
            _keychainFailed.add(id)
            set((s) => ({ providers: { ...s.providers } })) // re-persist with the fallback retained
          })
        }
        clearProviderCache()
      },

      getProviderApiKey: (id) => {
        return deobfuscate(get().providers[id]?.apiKey || '')
      },

      getEnabledProviders: () => {
        const providers = get().providers
        // GitHub #173: the additional OpenAI-compatible entries list next to
        // the slots, each as its own provider with its own model list.
        return [...Object.values(providers), ...get().openaiEntries]
          .filter((p) => p.enabled)
          .map((p) => ({
            ...p,
            apiKey: deobfuscate(p.apiKey), // deobfuscate for use
          }))
      },

      resetProvider: (id) => {
        // An extra slot has no shipped default to go back to: resetting it
        // is removing it.
        if (isCompatProviderId(id)) {
          get().removeCompatProvider(id)
          return
        }
        const before = get().providers[id]
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: DEFAULT_PROVIDERS[id],
          },
        }))
        // Opus review, round 2, Blocker 7: DEFAULT_PROVIDERS.openai carries
        // managed: true, so a reset of THIS slot really is "LU Engine chosen
        // again" in every sense but the literal one setProviderConfig checks
        // for (it writes `providers` directly, not through setProviderConfig,
        // so that auto-clear never runs). Without this the field's own
        // comment ("Built-in chosen again, Restore, or a full Reset") would
        // be a claim the code does not keep.
        if (id === 'openai') set({ engineOptedOut: false })
        if (id === 'openai') onLocalSlotChanged(before, get().providers.openai)
        if (keychainReady) {
          void vaultDelete(id).catch(() => { /* vault delete best-effort */ })
        }
        clearProviderCache()
        // A single-slot reset can switch that slot off too (ollama and
        // anthropic both default to enabled: false).
        dropPicksForDarkenedSlots({ [id]: before }, { [id]: get().providers[id] })
      },

      resetProvidersToDefaults: () => {
        const before = get().providers
        set((state) => {
          const next = {} as Record<ProviderId, ProviderConfig>
          // Extra slots are the user's own saved providers, not backend
          // configuration that has a shipped default: they stay as they are,
          // for the same reason stored API keys do.
          for (const id of Object.keys(state.providers) as ProviderId[]) {
            if (isCompatProviderId(id)) next[id] = state.providers[id]
          }
          for (const id of Object.keys(DEFAULT_PROVIDERS) as FixedProviderId[]) {
            next[id] = {
              ...DEFAULT_PROVIDERS[id],
              apiKey: state.providers[id]?.apiKey ?? '',
              ...(id === 'lu-cloud' ? { enabled: state.providers[id]?.enabled ?? false } : {}),
            }
          }
          return { providers: next }
        })
        // Opus review, round 2, Blocker 7: same reasoning as resetProvider
        // above, DEFAULT_PROVIDERS.openai is managed: true, so this hands the
        // slot back to LU Engine too, and the field's own comment promises
        // the mark clears on "a full Reset".
        set({ engineOptedOut: false })
        // GitHub #173: the shipped default has no additional entries, so they
        // go off. Off, not gone: their rows stay with Enable on them, the same
        // way the reset keeps the keys the user typed.
        const entriesBefore = get().openaiEntries
        set((s) => ({
          openaiEntries: s.openaiEntries.map((e) => (e.enabled ? { ...e, enabled: false, disabledByUser: true } : e)),
        }))
        dropPicksForDarkenedEntries(entriesBefore, get().openaiEntries)
        clearProviderCache()
        // Reset hands the slot back to the app's own engine, which voids a
        // pending unload rather than causing one.
        onLocalSlotChanged(before.openai, get().providers.openai)
        // ...but it switches every OTHER slot the user had enabled back off,
        // and a pick served by one of them is unservable from this moment on.
        dropPicksForDarkenedSlots(before, get().providers)
      },

      hydrateProviderKeys: async () => {
        // Probe + load keys from the OS keychain. The first secret_get that
        // RESOLVES (even returning null) proves the vault is usable here; a
        // reject on the very first probe means no keychain (web build, or Linux
        // "unsupported") → stay on the localStorage path and do nothing.
        const loaded: Partial<Record<ProviderId, string>> = {}
        let usable: boolean | null = null
        // The extra slots after the fixed ones: the first probe decides
        // whether there is a vault at all, and that question belongs to a
        // fixed entry, not to the parked namespace.
        const extra = (Object.keys(get().providers) as ProviderId[]).filter(isCompatProviderId)
        for (const id of [...PROVIDER_IDS, ...extra]) {
          try {
            const stored = await vaultGet(id)
            usable = true
            if (stored != null && stored !== '') {
              loaded[id] = stored
            } else {
              // Nothing in the vault yet. Migrate an existing localStorage key
              // (an upgrading user) into the vault, once. Read the CURRENT
              // store value, a key set while an earlier secret_get awaited
              // must not be missed.
              const existing = deobfuscate(get().providers[id]?.apiKey || '')
              if (existing) {
                // Migrate the old localStorage key into the vault. If the write
                // fails, mark it so partialize keeps the localStorage copy (no loss).
                try { await vaultSet(id, existing) } catch { _keychainFailed.add(id) }
              }
            }
          } catch {
            if (usable === null) { usable = false; break } // no keychain here
            // otherwise a transient per-key error, keep the others
          }
        }
        if (!usable) return
        // GitHub #173: the entries' keys live in the parked namespace, one
        // account per entry. Same migration rule as above: a key found only in
        // localStorage moves into the vault once.
        const loadedEntries: Record<string, string> = {}
        for (const e of get().openaiEntries) {
          const id = e.entryId
          if (!id) continue
          try {
            const stored = await secretParkGet(entryKeyAccount(id))
            if (stored != null && stored !== '') {
              loadedEntries[id] = stored
            } else {
              const existing = deobfuscate(get().openaiEntries.find((x) => x.entryId === id)?.apiKey || '')
              if (existing) {
                try { await secretParkSet(entryKeyAccount(id), existing) } catch { _entryKeychainFailed.add(id) }
              }
            }
          } catch {
            _entryKeychainFailed.add(id)
          }
        }
        keychainReady = true
        set((s) => ({
          openaiEntries: s.openaiEntries.map((e) => {
            const key = e.entryId ? loadedEntries[e.entryId] : undefined
            return key !== undefined ? { ...e, apiKey: obfuscate(key) } : e
          }),
        }))
        // Overlay ONLY the vault-loaded keys onto the LIVE state and re-persist.
        // A whole-map snapshot taken before the awaits would revert every
        // concurrent write (e.g. useCloudAuth enabling lu-cloud, or a Settings
        // edit, while a locked macOS keychain blocked secret_get for minutes).
        // partialize (now that keychainReady is true) strips the redundant
        // localStorage copy. clearProviderCache rebuilds any client constructed
        // during startup with an empty key.
        set((s) => ({
          providers: Object.fromEntries(
            Object.entries(s.providers).map(([id, p]) => {
              const key = loaded[id as ProviderId]
              return key !== undefined ? [id, { ...p, apiKey: obfuscate(key) }] : [id, p]
            }),
          ) as Record<ProviderId, ProviderConfig>,
        }))
        clearProviderCache()
      },
    }),
    {
      name: 'lu-providers',
      storage: safeJSONStorage(),
      // 2 since 3.0.7 (GitHub #173): `openaiEntries`. See migrateProviderState.
      version: 2,
      // A version WITHOUT a migrate is the one combination that loses data:
      // zustand logs "couldn't be migrated" and hydrates from defaults, i.e. it
      // throws every configured backend away.
      migrate: (persisted, version) => migrateProviderState(persisted, version) as ProviderState,
      // Blobs persisted before the lu-cloud provider existed lack its entry,
      // backfill every missing provider from defaults so getProvider() can't
      // hit an undefined config after an update.
      merge: (persisted: unknown, current: ProviderState): ProviderState => {
        const p = (persisted ?? {}) as Partial<ProviderState>
        const merged: Record<ProviderId, ProviderConfig> = { ...DEFAULT_PROVIDERS, ...(p.providers ?? {}) }
        // Extra slots: checked before anything reads them, and an entry that
        // does not pass is dropped rather than repaired.
        for (const id of Object.keys(merged) as ProviderId[]) {
          if (!isCompatProviderId(id)) continue
          const clean = sanitizeCompatSlot(id, merged[id])
          if (clean) merged[id] = clean
          else delete merged[id]
        }
        // 2.6.8 (A14): every store written before the rename carries the label
        // "Built-in Engine" on the openai slot, and a second copy of it in the
        // `displaced` memory when another backend pushed the engine aside. Both
        // are what the provider card and the standby card print, so both are
        // relabelled here. Only that exact name is touched, so a backend the
        // user named himself is left alone.
        //
        // This relabel MUST STAY WHILE OLD STORES EXIST. It is not a one-off
        // migration that a version bump retires: `version` is still 1 and the
        // blob is merged, not rewritten in place, so a machine that has not
        // been opened since 2.6.7 arrives here with the old name on its very
        // next launch, whenever that is. Deleting this puts "Built-in Engine"
        // back on that user's provider card. The READ side (isLuEngineName)
        // has to stay for the same reason, for rows recorded in old chats.
        //
        // Defensive on purpose: a hand-edited or truncated blob can carry a
        // null entry, and a merge that throws takes the whole provider store
        // down to defaults, which is every API key the user typed.
        //
        // `honourUserDisable` raeumt dabei das Paar `enabled: true` plus
        // `disabledByUser: true` weg, das ein Bau vor R2-14 anlegen konnte.
        // Es muss hier stehen und nicht in der Anzeige: der Widerspruch
        // laesst den Anbieter sonst weiter befragen, waehrend seine Zeile
        // weder DISABLED noch Enable zeigt. Die Marke der `displaced`-Haelfte
        // bleibt unangetastet, sie beschreibt einen Anbieter, der gar keine
        // eigene Zeile hat.
        for (const id of Object.keys(merged) as ProviderId[]) {
          const raw = merged[id]
          if (!raw || typeof raw !== 'object') continue
          const cfg = honourUserDisable(renameLegacyEngine(raw))
          const displaced = cfg.displaced ? renameLegacyEngine(cfg.displaced) : cfg.displaced
          if (cfg !== raw || displaced !== cfg.displaced) {
            merged[id] = displaced ? { ...cfg, displaced } : cfg
          }
        }
        // Opus review, round 2, Blocker 6: `engineOptedOut` is new in 3.0.1.
        // A blob written before it exists has no such key at all, so `...p`
        // below leaves the fresh-install default `false` standing, and that
        // reads as "LU Engine was evicted" for EVERY pre-3.0.1 customer whose
        // `openai` slot already carried `managed: false` from one of the five
        // deliberate pick UIs, the false positive Blocker 1 was fixed against,
        // now moved from the new customer to the existing one who actually
        // gets the update. Backfill: an old blob with no `openai.managed` and
        // no `displaced.managed` reads as "this installation opted out before
        // the flag existed", same one-sentence rule the rest of this file
        // uses, better a missed notice on old data than a false one.
        const openaiSlot = merged.openai
        const backfillOptedOut = !!openaiSlot && !openaiSlot.managed && !openaiSlot.displaced?.managed
        const engineOptedOut = p.engineOptedOut === undefined ? backfillOptedOut : p.engineOptedOut
        return {
          ...current,
          ...p,
          providers: merged,
          engineOptedOut,
          // GitHub #173: whatever arrives, only well formed entries stay.
          openaiEntries: sanitizeOpenAIEntries(p.openaiEntries),
        }
      },
      // Ollamas Adresse in backend.ts, sobald die gespeicherte da ist. Vorher
      // stand dort bis zu AppShells pullAndArm der Default localhost:11434,
      // und der erste Modellabruf beim Kaltstart (useModels.fetchModels) ging
      // an ein anderes Ollama: dessen Liste ersetzte die gespeicherte Wahl.
      // Rusts OLLAMA_HOST gewinnt danach wie gehabt (lib/ollama-host-sync.ts,
      // AppShell); spaetere Aenderungen traegt AppShells Subscription.
      onRehydrateStorage: () => (state) => {
        const base = state?.providers?.ollama?.baseUrl
        if (!base) return
        try { setOllamaBase(base) } catch { /* backend.ts nicht da (Testattrappe) */ }
      },
      // Don't persist transient state, only configs + user's "don't show again" preference.
      // When the OS keychain is active (H5), strip apiKey so the secret never
      // touches localStorage; otherwise keep the obfuscated key as before.
      partialize: (state) => ({
        providers: Object.fromEntries(
          Object.entries(state.providers).map(([id, p]) => {
            // Strip the ACTIVE key (it lives in the vault) UNLESS the vault
            // write failed for this id, then keep the obfuscated fallback.
            const stripActive = keychainReady && !_keychainFailed.has(id as ProviderId)
            const withActive = stripActive ? { ...p, apiKey: '' } : p
            // Opus-Review Nachbesserung 6: a PARKED key on the `displaced`
            // memory has no vault entry of its own, the OS keychain holds
            // exactly one credential per ProviderId, already spoken for by
            // whichever backend is active. Persisting it in the clear would
            // put a secret into localStorage with none of the protection
            // `apiKey` itself gets, so it never survives a persist, on any
            // platform. It still restores correctly within the same running
            // session (ProviderConfig.tsx reads it before this ever runs).
            if (!withActive.displaced?.apiKey) return [id, withActive]
            return [id, { ...withActive, displaced: { ...withActive.displaced, apiKey: undefined } }]
          })
        ) as Record<ProviderId, ProviderConfig>,
        hideBackendSelector: state.hideBackendSelector,
        engineOptedOut: state.engineOptedOut,
        // GitHub #173: an entry's key leaves localStorage once the vault holds
        // it, exactly like a slot's key above.
        openaiEntries: state.openaiEntries.map((e) =>
          keychainReady && e.entryId && !_entryKeychainFailed.has(e.entryId) ? { ...e, apiKey: '' } : e,
        ),
      }),
    }
  )
)
