import { useEffect, useLayoutEffect, useState } from 'react'
import { Header } from './Header'
import { StaleModelsBanner } from './StaleModelsBanner'
import { StorageQuotaToast } from './StorageQuotaToast'
import { Sidebar } from './Sidebar'
import { ChatView } from '../chat/ChatView'
import { ModelManager } from '../models/ModelManager'
import { SettingsPage } from '../settings/SettingsPage'
import { CreateExperimental } from '../create/experimental/CreateExperimental'
import { BenchmarkView } from '../models/BenchmarkView'
import { Onboarding } from '../onboarding/Onboarding'
import { BackendSelector } from '../onboarding/BackendSelector'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCompareStore } from '../../stores/compareStore'
import { useProviderStore } from '../../stores/providerStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useRemoteStore } from '../../stores/remoteStore'
import { useModelHealthStore } from '../../stores/modelHealthStore'
import { extractMemoriesFromPair } from '../../hooks/useMemory'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'
import { whenRunsIdle } from '../../lib/run-idle'
import { backendCall, isTauri } from '../../api/backend'
import { idbStorage } from '../../lib/idbStorage'
import { STORE_KEYS, IDB_STORE_KEYS, collectStoreSnapshot } from '../../lib/store-backup'
import { idbKeysToRestore, mayReloadForIdbRestore } from '../../lib/idb-restore'
import { log } from '../../lib/logger'
import { pickForMode } from '../../lib/active-model-mode'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useCloudAuth } from '../../hooks/useCloudAuth'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { useCreateStore } from '../../stores/createStore'
import { CloudGateModal } from '../cloud/CloudGateModal'
import { CloudTeaserModal } from '../cloud/CloudTeaserModal'
import { ReleaseNotesModal } from '../release/ReleaseNotesModal'
import { ShortcutsModal } from './ShortcutsModal'
import { CreditsExhaustedModal } from './CreditsExhaustedModal'
import { Titlebar } from './Titlebar'

// The backup triad must never write %APPDATA%/store_backup.json before the
// restore decision — on a post-NSIS boot the first doBackup would otherwise
// snapshot the wiped localStorage over the only good backup. Resolved on every
// exit path of the restore effect (intact-store fast path, restore-then-reload,
// no-backup fallback, browser give-up); module-level so a reload starts fresh.
let resolveRestoreDecided: () => void = () => {}
const restoreDecided = new Promise<void>((resolve) => { resolveRestoreDecided = resolve })

export function AppShell() {
  const { currentView } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  // A/B Compare takes over the chat area; hide the left chat sidebar entirely
  // while comparing (David 2026-06-06) so the two model columns get full width.
  const isComparing = useCompareStore((s) => s.isComparing)
  const onboardingDone = useSettingsStore((s) => s.settings.onboardingDone)
  const [restoring, setRestoring] = useState(false)

  const [detectedBackends, setDetectedBackends] = useState<DetectedBackend[]>([])
  const [showSelector, setShowSelector] = useState(false)

  useKeyboardShortcuts()
  // LU Cloud account boot: keychain session restore + /api/me probe; keeps
  // the cloud Create axis and the lu-cloud chat provider in sync.
  useCloudAuth()

  // ── Global Local/Cloud mode (2.5.7) — appMode drives everything ──
  const appMode = settings.appMode
  const cloudAvailable = useCloudAuthStore(deriveCloudAvailable)

  // Boot-sync the configured ComfyUI host/port into the FE URL builder.
  // The backend loads them from config.json at startup, but the only FE
  // mirror lived in SettingsPage's mount effect — so after an app restart
  // every comfyuiUrl() (gallery media, control plane) pointed at localhost
  // until the user happened to open Settings. On a remote-host setup (#82)
  // that made the app look dead after every launch. Found live 2026-07-17.
  useEffect(() => {
    void (async () => {
      try {
        const { backendCall, setComfyPort, setComfyHost, isMacOS } = await import('../../api/backend')
        // Not on the Mac: ComfyUI is never started and never renders there, so
        // mirroring its host/port can only teach the app a wrong address.
        if (isMacOS()) return
        const s = await backendCall<{ port?: number; host?: string }>('comfyui_status')
        if (typeof s?.port === 'number' && s.port > 0) setComfyPort(s.port)
        if (typeof s?.host === 'string' && s.host.trim()) setComfyHost(s.host)
      } catch { /* backend not up yet — Settings' own mirror still applies later */ }
    })()
  }, [])

  // Create renders where the mode says: the global switch owns the axis the
  // Composer's per-surface toggle used to.
  useEffect(() => {
    const target = appMode === 'cloud' && cloudAvailable ? 'cloud' : 'local'
    if (useCreateStore.getState().backend !== target) {
      useCreateStore.getState().setBackend(target)
    }
  }, [appMode, cloudAvailable])

  // Never leave an out-of-mode model active: flipping the switch moves the
  // chat selection onto the first model of the new mode (cloud ↔ local).
  // Depends on the model list too — the hosted catalog arrives ASYNC after
  // the lu-cloud provider gets enabled, so the reselect must fire again the
  // moment those models land.
  const allModels = useModelStore((s) => s.models)
  useEffect(() => {
    // Nothing to judge against yet. This guard is the whole of Befund 3 of
    // the abnahme counter-check (2026-08-29): the picked model did not
    // survive a restart, and the picker came back on a different model.
    //
    // The pick IS persisted, and it was rehydrated correctly. This effect
    // then ran on mount, before the first model list had landed, found the
    // active model in an empty array, decided it was out of mode and cleared
    // it. setModels later saw no active model and auto-selected the first
    // chat entry, which is how Qwen3 4B turned into Hermes over a restart.
    // An empty list is not evidence that a model is gone; it is the absence
    // of evidence, and this effect only ever runs again the moment the real
    // list arrives.
    const { activeModel, setActiveModel } = useModelStore.getState()
    // The rule itself lives in lib/active-model-mode.ts, where it can be
    // tested. It keeps chat models only (a ComfyUI checkpoint shares this
    // list and routes to Ollama as a chat model, where every send fails), it
    // holds the empty list harmless, and it clears rather than leaves an
    // out-of-mode model active when the new mode has nothing to offer: a
    // lu-cloud model left active in Local mode kept billing credits after the
    // switch said Local (Discord 2026-08-09, helpslowlydying).
    const pick = pickForMode(activeModel, allModels, appMode)
    if (pick.change) setActiveModel(pick.next)
  }, [appMode, allModels])

  // Local-hardware views (Models/Benchmark) don't exist in cloud mode — the
  // header hides them, this guard covers a view that was already open.
  useEffect(() => {
    const ui = useUIStore.getState()
    if (appMode === 'cloud' && (ui.currentView === 'models' || ui.currentView === 'benchmark')) {
      ui.setView('chat')
    }
  }, [appMode])

  // ── Cloud = cloud-only: release every LOCAL model backend so nothing sits
  // in RAM/VRAM while inference runs in the cloud (David 2026-07-11). Whisper
  // STT, the bundled llama.cpp sidecar + embeddings, Ollama-loaded models and
  // ComfyUI VRAM are freed by offload_local_models; LM Studio via its own JIT
  // unload (`lms unload --all`). Local mode reloads LAZILY on first use
  // (chat/voice/render) — nothing is pre-warmed. Fires on entering cloud
  // (switch OR launch-in-cloud); local mode is a no-op.
  useEffect(() => {
    if (!isTauri() || appMode !== 'cloud') return
    backendCall('offload_local_models').catch(() => {})
    backendCall('lmstudio_unload_model', { model: '--all' }).catch(() => {})
  }, [appMode])

  // Push the persisted ComfyUI GPU override to the backend on boot + change
  // (rhodium92 AMD, 2026-07-01). The backend resets to "auto" each launch, so
  // without this a saved force-cpu / force-gpu wouldn't apply until the user
  // re-opened Settings. Desktop-only — the web build has no local ComfyUI.
  useEffect(() => {
    if (!isTauri()) return
    backendCall('set_comfy_gpu_mode', { mode: settings.comfyGpuMode || 'auto' }).catch(() => {})
  }, [settings.comfyGpuMode])

  // ── Store backup/restore: survive NSIS updates that wipe WebView2 data ──
  // The key lists and the snapshot builder live in lib/store-backup so the
  // update path can ask for a backup too. It used to hand the process to the
  // installer with whatever the 5 s interval last wrote (Bug A1, 2.6.7).
  const STORE_KEYS_SET = new Set(STORE_KEYS)

  // Feature FF: reserved key under which memory embeddings ride inside the RAG
  // chunk backup file. Never collides with a real documentId (those are UUIDs).
  const MEMORY_VECTORS_BACKUP_KEY = '__memory_vectors__'

  // Split memory vectors out of a parsed RAG backup payload and import them
  // into the memory-embedding IndexedDB store. Best-effort. Returns the RAG-
  // only portion (memory key stripped) so the caller can import chunks cleanly.
  const restoreMemoryVectorsFrom = async (parsed: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const mem = parsed[MEMORY_VECTORS_BACKUP_KEY]
    if (mem && typeof mem === 'object' && !Array.isArray(mem)) {
      try {
        const { importAll: importMemoryVectors } = await import('../../lib/memoryEmbedDB')
        await importMemoryVectors(mem as Record<string, never>)
      } catch { /* best-effort */ }
    }
    const { [MEMORY_VECTORS_BACKUP_KEY]: _omit, ...ragOnly } = parsed
    return ragOnly
  }

  // On startup: if localStorage was wiped, restore from %APPDATA% backup.
  // Tauri v2 sets the global asynchronously via `withGlobalTauri` — on slow
  // cold-starts the first render beats it (commit 835ce86, same reason the
  // backup triad polls). A bare isTauri() bail here would skip the restore
  // permanently and let the triad's first doBackup clobber the backup file
  // with the freshly-wiped state, so we poll with the same 100 ms × 50 pattern.
  useEffect(() => {
    const runRestore = () => {
      const hasStores = STORE_KEYS.some(k => localStorage.getItem(k))
      const restoreComplete = localStorage.getItem('lu-restore-complete')
      if (hasStores && restoreComplete) {
        // localStorage intact, but IndexedDB might have been wiped (different
        // storage layer, different lifetime). Quietly restore RAG chunks if a
        // backup exists and the live store has none for the documents the
        // localStorage `rag-store` knows about. Best-effort; ignore errors.
        ;(async () => {
          // The chats live in IndexedDB too, and until now nothing on this
          // branch looked at them. A hard process kill mid write, which is
          // what a self update is, can leave Chromium discarding the whole
          // IndexedDB database while localStorage comes back whole, and this
          // branch IS that boot: every localStorage store answers, so the full
          // restore below never runs. aldrich_ironhart lost a 230k token
          // coding chat that way on 2.6.5 with a good copy of it sitting in
          // store_backup.json the entire time.
          try {
            const live: Record<string, string | null> = {}
            for (const key of IDB_STORE_KEYS) {
              live[key] = await Promise.resolve(idbStorage.getItem(key)).catch(() => null)
            }
            if (Object.values(live).some((v) => !v)) {
              const raw = await backendCall<string | null>('restore_stores')
              const parsed = raw ? JSON.parse(raw) : null
              const wanted = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? idbKeysToRestore(live, parsed as Record<string, unknown>)
                : []
              let back = 0
              for (const key of wanted) {
                try {
                  await Promise.resolve(idbStorage.setItem(key, (parsed as Record<string, string>)[key]))
                  back++
                } catch { /* one key failing must not stop the rest */ }
              }
              if (back > 0) {
                log.warn('[AppShell] IndexedDB stores were empty, restored from the appData backup', { keys: wanted })
                // The stores already hydrated empty, so only a reload picks
                // this up. Once per window session, never a loop.
                if (mayReloadForIdbRestore(typeof sessionStorage !== 'undefined' ? sessionStorage : null)) {
                  resolveRestoreDecided()
                  window.location.reload()
                  return
                }
              }
            }
          } catch { /* best-effort, the RAG restore below still runs */ }
          try {
            const data = await backendCall<string | null>('restore_rag_chunks')
            if (data) {
              const rawParsed = JSON.parse(data)
              if (rawParsed && typeof rawParsed === 'object' && !Array.isArray(rawParsed)) {
                // Feature FF: split memory embeddings out first, then restore the
                // RAG-only chunk portion. memoryEmbedDB.importAll is last-writer-
                // wins; safe to run on an intact-localStorage cold start.
                const parsed = await restoreMemoryVectorsFrom(rawParsed)
                const { exportAllChunks, importAllChunks } = await import('../../lib/ragDB')
                const live = await exportAllChunks()
                // Only import entries the live store is missing — never clobber
                // newer in-app activity with a stale backup.
                const toImport: Record<string, any> = {}
                for (const [docId, chunks] of Object.entries(parsed)) {
                  if (!live[docId] && Array.isArray(chunks) && chunks.length > 0) {
                    toImport[docId] = chunks
                  }
                }
                if (Object.keys(toImport).length > 0) {
                  await importAllChunks(toImport)
                }
              }
            }
          } catch { /* best-effort */ }
          // Release the triad only after the quiet import read the backup
          // file — doRagBackup would otherwise overwrite it first.
          resolveRestoreDecided()
        })()
        return
      }

      setRestoring(true)

      // 1. Fast path: check onboarding marker to prevent flash
      backendCall<boolean>('is_onboarding_done').catch(() => false).then(async (markerExists) => {
        // 2. Try full store restore
        try {
          const data = await backendCall<string | null>('restore_stores')
          if (data) {
            const parsed = JSON.parse(data)
            // Validate: must be a plain object with string values, only known keys
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              let restored = 0
              for (const [key, value] of Object.entries(parsed)) {
                if (STORE_KEYS_SET.has(key) && typeof value === 'string' && value) {
                  // IDB-backed keys go back to IndexedDB — the chat blob can
                  // exceed the ~5 MB localStorage quota (that's why those
                  // stores moved to IDB), and hydration reads them from there.
                  // Per-key try/catch: one failing key must not abort the rest.
                  try {
                    if (IDB_STORE_KEYS.has(key)) {
                      await Promise.resolve(idbStorage.setItem(key, value))
                    } else {
                      localStorage.setItem(key, value)
                    }
                    restored++
                  } catch { /* skip this key, keep restoring the rest */ }
                }
              }
              if (restored > 0) {
                // Pull RAG chunks from %APPDATA% before the reload so the new
                // localStorage references find their embeddings in IndexedDB
                // (Bug V, kj103x 2026-05-23). Best-effort: missing backup =
                // chunks need to be re-indexed by re-uploading docs.
                try {
                  const ragData = await backendCall<string | null>('restore_rag_chunks')
                  if (ragData) {
                    const parsedRag = JSON.parse(ragData)
                    if (parsedRag && typeof parsedRag === 'object' && !Array.isArray(parsedRag)) {
                      // Feature FF: restore memory embeddings, then RAG chunks.
                      const ragOnly = await restoreMemoryVectorsFrom(parsedRag as Record<string, unknown>)
                      const { importAllChunks } = await import('../../lib/ragDB')
                      await importAllChunks(ragOnly as Record<string, any>)
                    }
                  }
                } catch { /* best-effort */ }
                localStorage.setItem('lu-restore-complete', '1')
                resolveRestoreDecided()
                window.location.reload()
                return
              }
            }
          }
        } catch {}

        // 3. No backup available — at least recover onboarding from marker file
        if (markerExists) {
          updateSettings({ onboardingDone: true })
        }
        resolveRestoreDecided()
        setRestoring(false)
      })
    }

    if (isTauri()) {
      runRestore()
      return
    }
    let tries = 0
    const waitForTauri = setInterval(() => {
      tries++
      if (isTauri()) {
        clearInterval(waitForTauri)
        runRestore()
      } else if (tries >= 50) {
        // 5 s elapsed — probably browser dev session, nothing to restore.
        clearInterval(waitForTauri)
        resolveRestoreDecided()
      }
    }, 100)
    return () => clearInterval(waitForTauri)
  }, [])

  // Backup stores to %APPDATA% — three-pronged so chat history survives
  // NSIS updates + abrupt process kills:
  //   1. 10 s safety-net interval (was 30 s — too slow, users lost chats if
  //      they sent a message shortly before an upgrade).
  //   2. Debounced event-driven backup: 1 s after every chat/codex/memory
  //      mutation. Catches "typed + restart within interval window" case.
  //   3. beforeunload sync flush on Tauri window close. Fires for graceful
  //      quits and "X" button; does NOT fire for taskkill / NSIS upgrade
  //      (why we need 1+2 as well).
  // No dependency — we want this to run ONCE on mount and not rerun on
  // every settings flip. Tauri v2 sets `window.__TAURI__` asynchronously
  // via `withGlobalTauri` — on slower machines the first render fires
  // BEFORE the global exists, so we poll for up to 5 s, then arm the triad.
  useEffect(() => {
    let cleanup: (() => void) | null = null
    let disposed = false
    let tries = 0

    const setupTriad = async () => {
      // Never write the first backup before the restore effect decided — a
      // post-NSIS boot with wiped storage would otherwise snapshot the empty
      // state over the only good store_backup.json.
      await restoreDecided
      if (disposed) return

      let backupInflight = false
      // In-memory mirror of the IDB-backed values, refreshed by every doBackup
      // run. beforeunload can't await IndexedDB (the page is tearing down), so
      // the sync flush below reads from this cache instead — at most one
      // debounce-cycle stale, same freshness the old sync handler had.
      const idbCache: Record<string, string> = {}
      const doBackup = async () => {
        // Inflight guard: the 1 s debounce and the 5 s interval can overlap
        // now that the snapshot awaits IndexedDB reads.
        if (backupInflight) return
        backupInflight = true
        try {
          const snapshot = await collectStoreSnapshot(idbCache)
          // Always fire — we want backup even if snapshot is mostly empty, and the
          // sentinel tells the restore-flow this is a valid backup.
          localStorage.setItem('lu-restore-complete', '1')
          backendCall('backup_stores', { data: JSON.stringify(snapshot) }).catch(() => {})
        } catch { /* best-effort */ }
        backupInflight = false
      }

      // Separate, debounced backup for RAG IndexedDB chunks (Bug V, kj103x
      // 2026-05-23). These are heavy (768-float embedding vectors per chunk,
      // sometimes thousands per doc) so we don't bundle them into the chat
      // snapshot — the chat-store backup must stay fast for the 1 s debounce
      // case. RAG backup runs at most once every 30 s and after IndexedDB
      // grows, which is the right cadence: chunks change on document upload
      // / delete, both rare events compared to chat messages.
      let ragLastRun = 0
      let ragInflight = false
      const doRagBackup = async () => {
        if (ragInflight) return
        if (Date.now() - ragLastRun < 30_000) return
        ragInflight = true
        try {
          const { exportAllChunks } = await import('../../lib/ragDB')
          const { exportAll: exportMemoryVectors } = await import('../../lib/memoryEmbedDB')
          const snapshot = await exportAllChunks()
          // Feature FF: piggyback memory embeddings on the SAME backup file so
          // they survive an NSIS upgrade / WebView2 wipe alongside RAG chunks.
          // Stored under a reserved key (never a real documentId UUID); the
          // restore path splits it back out. importAllChunks ignores it anyway
          // because the value is an object, not a TextChunk[] array.
          const memVectors = await exportMemoryVectors()
          if (Object.keys(memVectors).length > 0) {
            ;(snapshot as Record<string, unknown>)[MEMORY_VECTORS_BACKUP_KEY] = memVectors
          }
          await backendCall('backup_rag_chunks', { data: JSON.stringify(snapshot) }).catch(() => {})
          ragLastRun = Date.now()
        } catch { /* best-effort */ }
        ragInflight = false
      }

      // Migration: write onboarding marker if missing AND user has already
      // onboarded (keeps NSIS-update recovery working). Do NOT rewrite the
      // marker for users who just hit Settings → "Re-run onboarding" — for
      // them onboardingDone is false, and the missing marker is intentional.
      backendCall<boolean>('is_onboarding_done').catch(() => false).then((markerExists) => {
        if (!markerExists && useSettingsStore.getState().settings.onboardingDone) {
          backendCall('set_onboarding_done').catch(() => {})
        }
      })

      void doBackup()  // first immediate backup
      // Same first-fire convention for RAG chunks so a fresh post-restore
      // boot writes a complete snapshot back to disk immediately.
      void doRagBackup()
      const interval = setInterval(doBackup, 5_000)
      const ragInterval = setInterval(() => { void doRagBackup() }, 30_000)

      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      const scheduleBackup = () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(doBackup, 1_000)
      }
      const unsubChat = useChatStore.subscribe(scheduleBackup)

      // Synchronous "last write" flush for beforeunload: doBackup awaits
      // IndexedDB reads, and an await during page teardown means the trailing
      // backup_stores invoke may never fire. Build the snapshot synchronously
      // from localStorage + the idbCache mirror instead — no await before the
      // invoke, restoring the pre-async guarantee.
      const flushSyncBackup = () => {
        try {
          const snapshot: Record<string, string> = { __ts: new Date().toISOString() }
          for (const key of STORE_KEYS) {
            const val = IDB_STORE_KEYS.has(key)
              ? (idbCache[key] ?? null)
              : localStorage.getItem(key)
            if (val) snapshot[key] = val
          }
          localStorage.setItem('lu-restore-complete', '1')
          backendCall('backup_stores', { data: JSON.stringify(snapshot) }).catch(() => {})
        } catch { /* best-effort */ }
      }

      const onBeforeUnload = () => {
        // The 5 s / 30 s intervals cover the common case; this is the "last
        // write" insurance for changes since the previous interval. Must stay
        // synchronous — see flushSyncBackup.
        flushSyncBackup()
        void doRagBackup()
      }
      window.addEventListener('beforeunload', onBeforeUnload)

      cleanup = () => {
        clearInterval(interval)
        clearInterval(ragInterval)
        if (debounceTimer) clearTimeout(debounceTimer)
        unsubChat()
        window.removeEventListener('beforeunload', onBeforeUnload)
      }
    }

    const waitForTauri = setInterval(() => {
      tries++
      if (isTauri()) {
        clearInterval(waitForTauri)
        void setupTriad()
      } else if (tries >= 50) {
        // 50 × 100 ms = 5 s. Give up silently — probably browser dev session.
        clearInterval(waitForTauri)
      }
    }, 100)

    return () => {
      disposed = true
      clearInterval(waitForTauri)
      if (cleanup) cleanup()
    }
  }, [])

  // Bug (h): synchronously sync the theme class with the persisted setting
  // BEFORE first paint, so the user never sees a one-frame white flash on
  // launch. useLayoutEffect runs before the browser commits the paint;
  // useEffect (the previous code) ran after, which produced the
  // "build sometimes opens white" symptom. Default-`dark` is also baked
  // into index.html so the very first paint (before any React renders)
  // is already dark even on cold-start.
  useLayoutEffect(() => {
    const isDark = settings.theme !== 'light' // unset / undefined → dark
    document.documentElement.classList.toggle('dark', isDark)
    document.documentElement.classList.toggle('light', !isDark)
  }, [settings.theme])

  // ── Issue #31: Ollama host sync (Rust ↔ frontend) ─────────────
  // Two async prereqs to serialize against:
  //   (a) Tauri v2 `__TAURI_INTERNALS__` is set async via `withGlobalTauri`.
  //   (b) Zustand `persist` middleware hydrates `lu-providers` async — if we
  //       push Rust's value into the store BEFORE hydration finishes,
  //       hydration replays the stale localStorage baseUrl and clobbers us.
  //
  // The deliberate order:
  //   1. Wait for the Tauri global via the same 100ms × 50-tick poll the
  //      backup triad uses (v2.3.3 commit 835ce86).
  //   2. Use zustand's own `onFinishHydration` callback for ordering against
  //      hydration — more reliable than polling `hasHydrated()` because it
  //      fires deterministically AFTER the replay, not whenever we happen
  //      to check.
  //   3. Fetch Rust's resolved base (config.json > OLLAMA_HOST > default)
  //      and push it into both the providerStore and backend.ts, regardless
  //      of what hydration just wrote — Rust wins at cold start.
  //   4. Arm a zustand subscribe listener for future GUI edits so
  //      `set_ollama_host` keeps Rust's config.json authoritative.
  useEffect(() => {
    let cancelled = false
    let tries = 0
    let storeUnsub: (() => void) | null = null
    let hydrationUnsub: (() => void) | null = null

    const armSubscription = () => {
      storeUnsub = useProviderStore.subscribe(async (state, prev) => {
        const next = state.providers.ollama?.baseUrl
        const old = prev.providers.ollama?.baseUrl
        if (!next || next === old || cancelled) return
        const { setOllamaBase } = await import('../../api/backend')
        setOllamaBase(next)
        if (isTauri()) {
          backendCall('set_ollama_host', { host: next }).catch(() => {})
        }
      })
    }

    const pullAndArm = async () => {
      if (cancelled) return
      const { setOllamaBase } = await import('../../api/backend')

      // Arm the store subscription FIRST, so that the setProviderConfig
      // below fires its listener (which writes back to Rust via
      // `set_ollama_host`). If we armed after, the initial sync would not
      // reach config.json and users with OLLAMA_HOST would see an empty
      // `ollama_base` field there.
      if (!cancelled) armSubscription()

      try {
        const res = await backendCall<{ base?: string }>('get_ollama_host')
        if (!cancelled && res?.base) {
          setOllamaBase(res.base)
          const current = useProviderStore.getState().providers.ollama?.baseUrl
          if (current !== res.base) {
            useProviderStore.getState().setProviderConfig('ollama', { baseUrl: res.base })
          }
        }
      } catch { /* Rust not ready — providerStore wins, subscription handles later edits */ }

      const current = useProviderStore.getState().providers.ollama?.baseUrl
      if (!cancelled && current) setOllamaBase(current)
    }

    const afterHydration = () => {
      // Either hydration already finished (so we run now) or we register a
      // one-shot callback for when it does.
      const persist = (useProviderStore as any).persist
      if (!persist || persist.hasHydrated?.()) {
        void pullAndArm()
      } else {
        hydrationUnsub = persist.onFinishHydration?.(() => { void pullAndArm() }) ?? null
      }
    }

    const waitForTauri = setInterval(() => {
      if (cancelled) { clearInterval(waitForTauri); return }
      tries++
      if (isTauri()) {
        clearInterval(waitForTauri)
        afterHydration()
      } else if (tries >= 50) {
        // 5 s elapsed — probably browser dev session. Still wire the store
        // subscription so user edits reach Rust if Tauri appears later.
        clearInterval(waitForTauri)
        armSubscription()
      }
    }, 100)

    return () => {
      cancelled = true
      clearInterval(waitForTauri)
      if (storeUnsub) storeUnsub()
      if (hydrationUnsub) hydrationUnsub()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Mirror remote mobile chat into the dispatched desktop conversation ──
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    ;(async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<{ role: string; content: string; model?: string; mode?: string; chat_id?: string; chat_title?: string }>(
        'remote-chat-message',
        (event) => {
          const { role, content, mode, chat_id, chat_title, model } = event.payload || ({} as any)
          if (!role || !content) return
          const chat = useChatStore.getState()

          // ── Codex route ──────────────────────────────────────────────
          // Find or create a Codex desktop conversation keyed by the mobile
          // chat_id so successive messages from the same mobile Codex chat
          // land in the same desktop conversation. Marked with `mode: 'codex'`
          // so the Code sidebar tab picks them up.
          if (mode === 'codex') {
            const mobileChatId = chat_id || 'mobile-codex'
            const tagged = `[mobile:${mobileChatId}]`
            let conv = chat.conversations.find((c) =>
              c.mode === 'codex' && (c.title.includes(tagged) || (c as any).remoteChatId === mobileChatId),
            )
            let convId = conv?.id
            if (!convId) {
              const title = (chat_title && chat_title.trim())
                ? `${chat_title}  ${tagged}`
                : `Mobile Coding Agent  ${tagged}`
              const activeModel = useModelStore.getState().activeModel || model || ''
              convId = chat.createConversation(activeModel, '', 'codex')
              chat.renameConversation(convId, title)
            }
            // Dedup
            const refreshed = useChatStore.getState().conversations.find((c) => c.id === convId)
            const last = refreshed?.messages[refreshed.messages.length - 1]
            if (last && last.role === role && last.content === content) return
            useChatStore.getState().addMessage(convId, {
              id: `remote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              role: role as any,
              content,
              timestamp: Date.now(),
            })
            return
          }

          // ── Default LU route: dispatched conversation ────────────────
          const { dispatchedConversationId } = useRemoteStore.getState()
          if (!dispatchedConversationId) return
          const conv = chat.conversations.find((c) => c.id === dispatchedConversationId)
          const last = conv?.messages[conv.messages.length - 1]
          if (last && last.role === role && last.content === content) return
          chat.addMessage(dispatchedConversationId, {
            id: `remote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            role: role as any,
            content,
            timestamp: Date.now(),
          })

          // Auto-extract memories from remote user/assistant pairs so Remote
          // sessions contribute to the same cross-chat memory as desktop.
          if (role === 'assistant' && content.trim()) {
            const afterAdd = useChatStore
              .getState()
              .conversations.find((c) => c.id === dispatchedConversationId)
            const msgs = afterAdd?.messages || []
            let userMsg = ''
            for (let i = msgs.length - 2; i >= 0; i--) {
              if (msgs[i].role === 'user') {
                userMsg = msgs[i].content
                break
              }
            }
            if (userMsg) {
              extractMemoriesFromPair(userMsg, content, dispatchedConversationId).catch(
                () => {},
              )
            }
          }
        },
      )
    })()
    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  // Ollama 0.20.7 stale-manifest scan — runs once per session shortly after
  // startup. Flags installed models that the server now rejects with "does
  // not support chat/completion/generate" (pulled before the registry-side
  // capabilities refresh). Populates useModelHealthStore → StaleModelsBanner
  // surfaces the result as a top-of-app notice with one-click Refresh All.
  useEffect(() => {
    if (!onboardingDone || !isTauri()) return
    if (sessionStorage.getItem('lu-model-health-scan-done')) return
    sessionStorage.setItem('lu-model-health-scan-done', '1')

    // 3 s delay: give Ollama time to respond to /api/version after cold start
    // and avoid racing the backend-detection effect below.
    const timer = setTimeout(async () => {
      try {
        useModelHealthStore.getState().setScanning(true)
        const { scanInstalledModels, checkConnection } = await import('../../api/ollama')
        const ok = await checkConnection()
        if (!ok) return
        const results = await scanInstalledModels()
        const stale = results.filter((r) => r.stale).map((r) => r.name)
        useModelHealthStore.getState().setStaleModels(stale)
      } catch {
        // Scan is best-effort — silently fall back if Ollama is unreachable.
      } finally {
        useModelHealthStore.getState().setScanning(false)
      }
    }, 3000)
    return () => clearTimeout(timer)
  }, [onboardingDone])

  // Auto-detect local backends on startup (once per session)
  useEffect(() => {
    if (!onboardingDone) return
    if (sessionStorage.getItem('lu-backend-detection-done')) return

    sessionStorage.setItem('lu-backend-detection-done', '1')

    detectLocalBackends().then((backends) => {
      if (backends.length === 0) return

      // Auto-adopt the first non-Ollama openai-compat backend we find — but
      // NOT when the app-managed built-in engine owns the `openai` slot.
      // 2.5.7: that slot now holds the bundled llama-server (managed:true) by
      // default. Silently overwriting it here would leave `managed:true`
      // pointing at a foreign URL (LM Studio / vLLM), breaking the model list
      // (`list_bundled_models`) and the fixed-URL assumption. So we only
      // auto-adopt an external backend when the user has already switched away
      // from the built-in engine (slot not managed). When the built-in engine
      // is the active default, detected externals stay opt-in via the selector
      // modal below and Settings → Providers ("use another engine").
      // (Pre-2.5.7 rationale — Discord #help-chat, djoks.exe 2026-04-21: without
      //  auto-enable, dismissing the selector left LM Studio disabled and its
      //  models never appeared. Still true for users who left the built-in slot.)
      const openaiSlot = useProviderStore.getState().providers.openai
      const nonOllama = backends.find((b) => b.id !== 'ollama')
      if (nonOllama && !openaiSlot.managed) {
        useProviderStore.getState().setProviderConfig('openai', {
          enabled: true,
          name: nonOllama.name,
          baseUrl: nonOllama.baseUrl,
          isLocal: true,
          managed: false,
        })
      }

      // Also auto-(re)enable Ollama when it's detected. The provider defaults
      // to enabled=true, but a previous session may have disabled it; here we
      // pin the detected baseUrl and bring it back so models show up in the
      // Settings → AI Backends list and the chat selector.
      const detectedOllama = backends.find((b) => b.id === 'ollama')
      if (detectedOllama) {
        useProviderStore.getState().setProviderConfig('ollama', {
          enabled: true,
          baseUrl: detectedOllama.baseUrl,
          isLocal: true,
        })
      }

      // Single backend → we're done (already enabled above, or was Ollama).
      if (backends.length === 1) return

      // User previously opted out of the selector (tickbox "don't show again")
      // → never re-show. They manage providers via Settings → Providers.
      // This is the persistent guard; the sessionStorage check above is just
      // the within-session guard.
      if (useProviderStore.getState().hideBackendSelector) return

      // Multiple backends detected → show selection dialog so the user can
      // change which one is the primary openai-compat provider if they want.
      // G25: never mid-run. Detection lands seconds after startup, and when a
      // run was already streaming by then the modal stood over the chat for
      // the rest of a 20 minute agent run (R17c). Wait until every surface
      // (chat, agent, coding) is idle before opening it.
      whenRunsIdle(() => {
        setDetectedBackends(backends)
        setShowSelector(true)
      })
    })
  }, [onboardingDone])

  // While restoring from backup, show nothing (prevents onboarding flash)
  if (restoring) return null

  if (!onboardingDone) {
    return <Onboarding />
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-100 dark:bg-[#141414] text-gray-900 dark:text-gray-100">
      <div className="h-full flex flex-col">
        <Titlebar />
        <Header />
        <StaleModelsBanner />
        <StorageQuotaToast />
        <div className="flex-1 flex overflow-hidden gap-2 p-2">
          {!isComparing && <Sidebar />}
          <main className="flex-1 overflow-hidden rounded-xl bg-white dark:bg-[#1e1e1e] ring-1 ring-black/[0.04] dark:ring-white/[0.05]">
            {currentView === 'chat' && <ErrorBoundary><ChatView /></ErrorBoundary>}
            {currentView === 'models' && <ErrorBoundary><ModelManager /></ErrorBoundary>}
            {currentView === 'benchmark' && <ErrorBoundary><BenchmarkView /></ErrorBoundary>}
            {currentView === 'settings' && <ErrorBoundary><SettingsPage /></ErrorBoundary>}
            {currentView === 'create' && <ErrorBoundary><CreateExperimental /></ErrorBoundary>}
          </main>
        </div>
      </div>

      {/* Backend selection dialog (shown when multiple local backends detected) */}
      <BackendSelector
        open={showSelector}
        backends={detectedBackends}
        onClose={() => setShowSelector(false)}
      />
      {/* Cloud gate: login → plan → beta wall, opened by the header switch. */}
      <CloudGateModal />
      {/* Cloud discovery sheet: opened by the Local-mode teaser surfaces
          (locked Create tabs, hosted model rows). */}
      <CloudTeaserModal />
      {/* What is new, once per version. Mounted inside the onboarded tree, so
          it can never stack on top of the onboarding wizard. */}
      <ReleaseNotesModal />
      <ShortcutsModal />
      {/* Out-of-credits purchase prompt: opens when LU Cloud answers
          code:'credits_exhausted' (monthly budget + top-up wallet empty). */}
      <CreditsExhaustedModal />
    </div>
  )
}
