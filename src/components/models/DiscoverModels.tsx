import { useCallback, useState, useEffect, useRef } from 'react'
import { bundleIsComplete, bundleIsDownloading, bundleHasErrors } from '../../lib/bundle-state'
import { motion } from 'framer-motion'
import { Search, XCircle, Loader2, Sparkles, Unlock, ShieldCheck, ExternalLink, Download, CheckCircle, Info } from 'lucide-react'
import { X } from 'lucide-react'
import {
  searchHuggingFaceModels,
  getImageBundles, getVideoBundles,
  getUncensoredTextModels, getMainstreamTextModels,
  detectProviderModelPath, startModelDownloadToPath, luEngineDownloadDir,
  startModelDownload, searchCivitaiModels,
  installBundleComplete, checkBundlesInstalled, resolveHfGgufFiles, planModelDownload,
  type DiscoverModel, type DownloadProgress, type ModelBundle, type CivitAIModelResult, type HfGgufFile,
} from '../../api/discover'
import { getSystemVRAM } from '../../api/comfyui'
import { getMaxVramGb, getTotalRamGb, bundleVramNeedGb } from '../../lib/hardware'
import { openExternal } from '../../api/backend'
import { useModels } from '../../hooks/useModels'
import { useDownloadStore } from '../../stores/downloadStore'
import { CivitaiResultsSkeleton, ModelGridSkeleton } from '../layout/ViewSkeletons'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { getProviderIdFromModel } from '../../api/providers'
import { activateDownloadedBundledModel } from '../../lib/bundled-download-activation'
import { diagnoseBuiltinEngine } from '../../api/builtin-ensure'
import type { InstalledModelLike } from '../../lib/lmstudio-match'
import { findInstalledForDiscoverModel } from '../../lib/discover-installed'
import { isBuiltinEngineEntry } from '../../lib/lmstudio-match'
import { ensureLuEngineIsChatProvider, announceLuEngineSwitch } from '../../api/lu-engine-switch'
import { LuEngineSwitchBar } from '../chat/LuEngineSwitchBar'
import { resolveTextDownloadTarget } from '../../lib/text-download-target'
import { hfUrlToOllamaRef, hfUrlToLmStudioSubdir, parseHfUrl, extractGgufQuant, isShardedOrIncompatibleGguf } from '../../lib/hf-to-provider'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'
import { Modal } from '../ui/Modal'
import { formatBytes, countLabel } from '../../lib/formatters'
import type { ModelCategory } from '../../types/models'
import { proxyImageUrl } from '../../lib/privacy'
import { log } from '../../lib/logger'
import {
  ModelTile, BundleTile, HardwareChip, groupModels, pickDefaultVariant, computeFit,
  CapLegend,
} from './ModelTiles'
import { ICON_SM } from '../ui/icon-size'

interface Props {
  category: ModelCategory
  /** Filter query driven by the ModelManager header search input. */
  search?: string
  /** Bumped by ModelManager whenever the user submits the search (Enter). */
  searchSubmitToken?: number
}

// Size buckets stay EXACTLY the ones from the old VRAM-tier filter (David
// 2026-06-06) — only the labels turned human. 'fit' is new and additive:
// it filters on the detected GPU instead of a fixed bucket.
type SizeTier = 'all' | 'fit' | 'ultra' | 'light' | 'middle' | 'highend'

// ─── D-S25 · eine Segmented-Sprache statt zwei ──────────────────────
//
// Der Befund: „Zwei Segmented-Sprachen 47px uebereinander: Mainstream/
// Unfiltered rechteckig, Groessenfilter als Pills." Beide Reihen sind
// dasselbe Bedienelement — eine Reihe, aus der genau EINE Sache aktiv ist —
// und sahen komplett verschieden aus:
//
//   Reihe 1  Behaelter mit Rand, `rounded-md`-Segmente, 0.66rem fett,
//            aktiv = weisse Flaeche + `shadow-sm`
//   Reihe 2  freistehende `rounded-full`-Pillen, jede mit eigenem Rand,
//            11px halbfett, aktiv = graue Flaeche + dunklerer Rand
//
// Dazu zwei Zustandsquellen: Reihe 1 setzte `aria-pressed` UND faerbte
// selbst, Reihe 2 faerbte nur. Jetzt tragen beide Reihen dieselbe Spur und
// dieselben Segmente, und der aktive Zustand kommt an BEIDEN Stellen aus
// `aria-pressed` — `.lu-control` liest ihn (index.css). Kein Segment
// faerbt sich mehr selbst, also kann die Optik nicht mehr neben der
// Barrierefreiheit herlaufen.
//
// Nebenbei faellt hier das zweite `shadow-sm` des Screens weg (D-S24): der
// aktive Zustand kommt aus Flaeche + Textfarbe, die auf `#141414`
// gerechnet sind, nicht aus einem Hell-Modus-Schatten, den dort niemand
// sieht.
//
// Die Spur ist bewusst KEIN neues Rezept in index.css, sondern nur der
// Behaelter um die vorhandenen Controls: 2px Luft (`p-0.5`) und ein Radius,
// der eine Stufe ueber dem der Segmente liegt, damit die Ecken parallel
// laufen (`--radius-control` + 2px).
//
// Mitgenommen aus der Zeile, die hier vorher stand, weil die Falle bleibt:
// ein aktives Segment darf NICHT `text-white`/`bg-gray-900` invertieren —
// die Rettungsregel `.light .text-white` in index.css macht daraus im
// Hellmodus Gray-900 auf Gray-900. `.lu-control` faellt nicht hinein: sein
// aktiver Zustand ist im Hellmodus `rgb(17 24 39)` auf `rgba(0,0,0,.05)`,
// also weder `text-white` noch eine dunkle Flaeche.
const SEGMENT_TRACK =
  'inline-flex items-center gap-0.5 p-0.5 rounded-[calc(var(--radius-control)+2px)] '
  + 'bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] '
  + 'flex-wrap'

// ─── T-69 · Auf eine Datei warten, ohne einen Timer zu hinterlassen ──

/** Wie das Warten geendet hat. Nur `complete` heisst „weitermachen". */
export type FileWaitOutcome = 'complete' | 'paused' | 'cancelled' | 'aborted'

/**
 * Genau das, was das Warten vom Download-Store braucht: den aktuellen Stand
 * lesen und mitbekommen, wenn er sich aendert. Absichtlich nicht der ganze
 * Store — so laesst sich die Wartefunktion gegen einen echten zustand-Store
 * pruefen, ohne dass der Test Tauri oder Rust braucht.
 */
export interface DownloadWatcher {
  getState: () => { downloads: Record<string, DownloadProgress> }
  subscribe: (listener: () => void) => () => void
}

/**
 * Wie lange „der Eintrag ist noch nicht da" geduldet wird, bevor es als
 * Fehlschlag gilt. Rust hat den Auftrag zu diesem Zeitpunkt schon
 * angenommen (`startModelDownloadToPath` ist `await`ed durch), es fehlt nur
 * noch der erste `refresh()` — das dauert Sekunden, nicht Minuten.
 */
export const FIRST_SIGHT_MS = 30_000

/**
 * Warten, bis eine Datei fertig heruntergeladen ist — als Abonnement, nicht
 * als Timer.
 *
 * Der Befund (Technik-Audit, „Discovery & Downloads", T-69): der
 * Built-in-Engine-Installpfad wartete mit einem `setInterval(…, 500)`, das
 * `clearInterval` nur in zwei von fuenf moeglichen Ausgaengen rief —
 * `complete` und `error`. Pausiert der Nutzer, steht der Eintrag auf
 * `paused`; bricht er ab, verschwindet der Eintrag ganz; verlaesst er die
 * Ansicht, ist niemand mehr da, der zuhoert. In allen drei Faellen traf der
 * Timer keinen der beiden Zweige, lief mit 2 Hz weiter, und das Promise, auf
 * das die Installation `await`ete, settelte nie. Pro Versuch ein Timer, und
 * die Schleife darunter stand fuer immer.
 *
 * Hier gibt es keinen zweiten Timer mehr. Der Store wird von `startPolling()`
 * ohnehin im Sekundentakt aus Rust nachgefuellt, und jedes `set()`
 * benachrichtigt seine Abonnenten — gewartet wird also auf die Nachricht, die
 * es schon gibt.
 *
 * Fuenf Ausgaenge, und jeder raeumt hinter sich auf:
 *
 *   `complete`      die Datei liegt auf Platte      → `'complete'`
 *   `error`         Rust meldet den Fehlschlag      → `reject`
 *   `paused`        der Nutzer hat angehalten       → `'paused'`
 *   Eintrag weg     der Nutzer hat abgebrochen      → `'cancelled'`
 *   `signal`        Ansicht weg / neuer Versuch     → `'aborted'`
 *
 * Warum `paused` beendet statt weiterzuwarten: die Installation verspricht
 * „Modell laden, dann die Engine darauf starten". Ein Start von llama-server
 * raeumt VRAM frei und wechselt das aktive Modell — das eine halbe Stunde
 * spaeter im Hintergrund zu tun, weil der Nutzer irgendwann fortgesetzt hat,
 * waere schlimmer als es gar nicht zu tun. Der Nutzer erfaehrt genau das
 * (`installNotice`), statt dass die Installation still stehenbleibt.
 *
 * `cancelled` wird ERST gemeldet, nachdem der Eintrag einmal gesehen wurde.
 * Zwischen dem Start des Downloads und dem ersten `refresh()` existiert er
 * noch nicht, und „noch nicht da" ist nicht dasselbe wie „geloescht". Damit
 * ein Eintrag, der ueberhaupt nie auftaucht, die alte Haengerei nicht durch
 * die Hintertuer zurueckholt, hat genau dieses Fenster eine Frist —
 * `FIRST_SIGHT_MS`, und der eine `setTimeout` dafuer wird auf jedem Ausgang
 * geloescht.
 */
export function awaitDownloadedFile(
  watcher: DownloadWatcher,
  filename: string,
  signal: AbortSignal,
  firstSightMs: number = FIRST_SIGHT_MS,
): Promise<FileWaitOutcome> {
  return new Promise<FileWaitOutcome>((resolve, reject) => {
    let seen = false
    let settled = false
    let unsubscribe: (() => void) | null = null
    let firstSight: ReturnType<typeof setTimeout> | null = null

    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      if (firstSight !== null) { clearTimeout(firstSight); firstSight = null }
      signal.removeEventListener('abort', onAbort)
      unsubscribe?.()
      unsubscribe = null
      finish()
    }

    function onAbort() {
      settle(() => resolve('aborted'))
    }

    const look = () => {
      const d = watcher.getState().downloads[filename]
      if (!d) {
        // Weg, nachdem er da war = `cancel()` hat die Zeile geloescht.
        if (seen) settle(() => resolve('cancelled'))
        return
      }
      seen = true
      if (firstSight !== null) { clearTimeout(firstSight); firstSight = null }
      if (d.status === 'complete') settle(() => resolve('complete'))
      else if (d.status === 'error') settle(() => reject(new Error(d.error || 'Download failed')))
      else if (d.status === 'paused') settle(() => resolve('paused'))
    }

    if (signal.aborted) { resolve('aborted'); return }
    signal.addEventListener('abort', onAbort)
    firstSight = setTimeout(
      () => settle(() => reject(new Error(`${filename} never showed up in the download list`))),
      firstSightMs,
    )
    unsubscribe = watcher.subscribe(look)
    // Der Stand von JETZT zaehlt auch: ein Abonnement allein verpasst eine
    // Datei, die schon fertig ist.
    look()
  })
}

export function DiscoverModels({ category, search = '', searchSubmitToken = 0 }: Props) {
  const [civitaiResults, setCivitaiResults] = useState<CivitAIModelResult[]>([])
  const [civitaiSearching, setCivitaiSearching] = useState(false)
  const [civitaiQuery, setCivitaiQuery] = useState('')
  // Track whether the *latest* CivitAI search has been issued at least once,
  // so an empty-state hint can render between "before-first-search" and
  // "search returned 0 hits". Without this we fall through to the silent gap
  // diimmortalis described — empty list, no console output, looks like the
  // button did nothing.
  const [civitaiSearched, setCivitaiSearched] = useState(false)
  // CivitAI mirror host (#53) — civitai.red for regions where .com is blocked.
  const civitaiHost = useWorkflowStore((s) => s.civitaiHost)
  const setCivitaiHost = useWorkflowStore((s) => s.setCivitaiHost)
  const [loading, setLoading] = useState(false)
  const [systemVRAM, setSystemVRAM] = useState<number | null>(null)
  const [ramGb, setRamGb] = useState<number | null>(null)
  // Mainstream is the default + first tab (David 2026-07-17) — Unfiltered is
  // one click away but new users land on the neutral list.
  const [subTab, setSubTab] = useState<'uncensored' | 'mainstream'>('mainstream')
  const [vramTier, setVramTier] = useState<SizeTier>('all')
  // Details modal — the card shows one calm line; the FULL catalog description
  // (incl. per-model tips like "run thinking-OFF") lives here.
  const [infoModel, setInfoModel] = useState<DiscoverModel | null>(null)
  const downloads = useDownloadStore(s => s.downloads)
  const dlStore = useDownloadStore

  // Provider state for model path detection
  const providers = useProviderStore(s => s.providers)
  const hfOverride = useSettingsStore(s => s.settings.hfDownloadPathOverride)
  // Bug Y/a v2.5.0 — Aldrich Ironhart Discord. We need to know which provider
  // the user is actually chatting against, not just which one is enabled,
  // because both can be enabled at once and the active picker decides where
  // the file should land. `activeModel` is `<providerId>::<id>` for non-Ollama
  // backends and a bare name for Ollama.
  const activeChatModel = useModelStore(s => s.activeModel)
  const [hfModelPath, setHfModelPath] = useState<string | null>(null)
  const { pullModel, models: installedModels, fetchModels, setActiveModel } = useModels()

  // Refresh installed-model list on mount + when category switches to text
  // so the Discover grid reflects what Ollama / LM Studio actually have on
  // disk (Bug #43: text-models never showed "Installed" because we only
  // checked the in-memory download-store, which is empty after a restart).
  useEffect(() => {
    if (category === 'text') fetchModels().catch(() => {})
  }, [category, fetchModels])

  // Auto-detect provider model path for GGUF downloads (user override wins).
  useEffect(() => {
    if (category !== 'text') return
    const override = hfOverride?.trim()
    if (override) { setHfModelPath(override); return }
    const providerName = providers.openai?.name || 'LM Studio'
    detectProviderModelPath(providerName).then(path => setHfModelPath(path))
  }, [category, hfOverride, providers.openai?.name])

  // Detect hardware for the "runs on your PC" hints. Two probes, best wins:
  // detect_gpus (nvidia-smi/rocm-smi/wmic — works WITHOUT ComfyUI running)
  // and ComfyUI's /system_stats (the pre-redesign source, kept as fallback).
  useEffect(() => {
    getMaxVramGb().then(v => {
      if (v > 0) setSystemVRAM(prev => Math.max(prev ?? 0, Math.round(v)))
    }).catch(() => {})
    getSystemVRAM().then(v => {
      if (v) setSystemVRAM(prev => Math.max(prev ?? 0, v))
    })
    getTotalRamGb().then(r => { if (r > 0) setRamGb(r) }).catch(() => {})
  }, [])

  // Check which bundles are REALLY installed (file size validated, not just file existence)
  const [bundleStatuses, setBundleStatuses] = useState<Record<string, boolean>>({})
  // Memoised so the two effects below can name it as the dependency it is
  // instead of hiding it from the dep array. It only closes over `category`,
  // so its identity changes exactly when the effects had to re-run anyway —
  // no re-subscription loop.
  const refreshBundleStatuses = useCallback(() => {
    if (category !== 'image' && category !== 'video') return
    const allBundles = [...getImageBundles(), ...getVideoBundles()]
    checkBundlesInstalled(allBundles).then(statuses => setBundleStatuses(statuses))
  }, [category])
  useEffect(() => {
    refreshBundleStatuses()
  }, [refreshBundleStatuses])

  // Re-check bundle statuses when a download completes
  useEffect(() => {
    const handler = () => refreshBundleStatuses()
    window.addEventListener('comfyui-model-downloaded', handler)
    return () => window.removeEventListener('comfyui-model-downloaded', handler)
  }, [refreshBundleStatuses])

  // Start polling on mount if there are active downloads
  useEffect(() => {
    dlStore.getState().refresh()
  }, [dlStore])

  const isText = category === 'text'
  const isImage = category === 'image'
  const isVideo = category === 'video'
  const bundles = isImage ? getImageBundles() : isVideo ? getVideoBundles() : []

  // How much VRAM a bundle wants, read by the ONE shared parser in
  // lib/hardware. The local copy that used to live here answered 99 GB to the
  // add-on bundles, whose requirement reads "any", so the sort buried them,
  // the tier filter hid them and the tile called a 0.17 GB LoRA too big for a
  // 12 GB card.
  const parseVRAM = (b: ModelBundle): number => bundleVramNeedGb(b)

  // Sort bundles: verified first, then HOT, then fits VRAM, then by size
  const sortedBundles = [...bundles].sort((a, b) => {
    // Verified models always first
    if (a.verified && !b.verified) return -1
    if (!a.verified && b.verified) return 1
    // HOT models next
    if (a.hot && !b.hot) return -1
    if (!a.hot && b.hot) return 1
    if (systemVRAM) {
      const aFits = parseVRAM(a) <= systemVRAM
      const bFits = parseVRAM(b) <= systemVRAM
      if (aFits && !bFits) return -1
      if (!aFits && bFits) return 1
    }
    return parseVRAM(a) - parseVRAM(b)
  })

  const tabFilteredBundles = sortedBundles.filter(b => subTab === 'uncensored' ? b.uncensored : !b.uncensored)

  // VRAM tier filtering for bundles
  const vramFilteredBundles = tabFilteredBundles.filter(b => {
    if (vramTier === 'all') return true
    const vram = parseVRAM(b)
    if (vramTier === 'fit') return systemVRAM ? vram <= systemVRAM + 2 : true
    if (vramTier === 'ultra') return vram <= 4
    if (vramTier === 'light') return vram > 4 && vram <= 10
    if (vramTier === 'middle') return vram > 10 && vram <= 20
    return vram > 20 // highend (open-ended)
  })

  const filteredBundles = search
    ? vramFilteredBundles.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()) || b.description.toLowerCase().includes(search.toLowerCase()))
    : vramFilteredBundles

  // Which model the Use button is currently loading. A GGUF start blocks for
  // seconds to minutes, and without this the button stayed live and a second
  // click queued a second start behind the first (review S6).
  const [usingModel, setUsingModel] = useState<string | null>(null)

  // Text-model installed check.
  //
  // Lives in lib/discover-installed.ts since 2.6.8, unit-tested, because the
  // rule it encodes is the whole of GH #118: installed is a question about the
  // DISK. The session download store, the Ollama store and, since the same
  // ticket, the built-in engine's own directory scan are all filesystem
  // evidence. Whether the engine answers on its port is a different question
  // with a different repair, and it must never be able to unsay "this 8 GB
  // file is on your machine" (Bug #43 was the first version of the same
  // mistake, nayffy's restart the second).
  const installedEntryFor = (model: DiscoverModel) =>
    findInstalledForDiscoverModel(model, downloads, installedModels as unknown as InstalledModelLike[])

  const isModelFullyInstalled = (model: DiscoverModel) => installedEntryFor(model) !== null

  /** Can the Use button do anything for this row: is the local model behind it
   *  known by its picker id. A download that finished in this session is on the
   *  disk but carries no id until the next model refresh, so it stays a badge. */
  const canUseInstalled = (model: DiscoverModel) => !!installedEntryFor(model)?.name

  /**
   * GH #118: "the Get button doesn't do anything as the files are still
   * downloaded". With the badge right, the state the user landed in was an
   * inert Installed pill beside an engine that was not running, and the Models
   * page offered no way on. This is that way on: pick the model, and start the
   * engine if it is down.
   *
   * The repair runs BEFORE the pick, because diagnoseBuiltinEngine starts the
   * engine on exactly this model when it is dead, and the pick then swaps only
   * when something else is loaded. The other order would start twice.
   *
   * Review B1: the repair is asked ONLY for a row that really belongs to the
   * app's own engine. An Ollama or LM Studio row has its own lifecycle, and
   * sending it through the built-in diagnosis would either boot a stranger's
   * GGUF that the pick then swaps straight back out, or, on a box with no
   * built-in GGUF at all, answer a click on a perfectly installed Ollama model
   * with "no chat model to load yet".
   */
  const handleUseInstalled = async (model: DiscoverModel) => {
    const entry = installedEntryFor(model)
    const name = entry?.name
    if (!name || usingModel) return
    setInstallError(null)
    setUsingModel(name)
    try {
      if (isBuiltinEngineEntry(entry)) {
        // A14: the LU Engine's GGUFs are listed even while Ollama or LM Studio
        // holds the chat, so Use has to hand the slot over first. It has to be
        // FIRST: diagnoseBuiltinEngine answers nothing at all for a slot that
        // is not ours, so the old order would repair nothing and then activate
        // a model no request routes to.
        if (ensureLuEngineIsChatProvider()) {
          announceLuEngineSwitch()
        }
        const diagnosis = await diagnoseBuiltinEngine({ repair: true, preferModel: name })
        if (!diagnosis.ok && diagnosis.reason) setInstallError(diagnosis.reason)
      }
      setActiveModel(name)
    } catch (e) {
      log.warn('[DiscoverModels] LU Engine repair failed', { err: e })
      setActiveModel(name)
    } finally {
      setUsingModel(null)
    }
  }

  const [installingBundle, setInstallingBundle] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  // Kein Fehler, sondern eine Auskunft: der Nutzer hat den Download angehalten
  // oder abgebrochen, und die Installation sagt, was das fuer die Engine
  // bedeutet. Der rote Banner darunter waere hier eine Falschaussage — Rot
  // heisst in dieser App „kaputt oder wird geloescht" (siehe die Begruendung
  // am `.lu-control`-Rezept in index.css).
  const [installNotice, setInstallNotice] = useState<string | null>(null)
  // T-69: ein Controller pro Installationsversuch. Er bricht ab, wenn die
  // Ansicht verschwindet — AppShell haengt Models an `currentView === 'models'`
  // (`AppShell.tsx:955`), ein Wechsel haengt sie also wirklich ab — und wenn
  // ein neuer Versuch startet.
  const installWaitRef = useRef<AbortController | null>(null)
  useEffect(() => () => installWaitRef.current?.abort(), [])
  // Confirmation gate for multi-part (sharded) downloads — these sets routinely
  // run hundreds of GB across many files, so we never start them silently.
  const [confirmDownload, setConfirmDownload] = useState<{ name: string; files: HfGgufFile[]; targetDir: string; totalGB: number; note?: string } | null>(null)

  // Download a resolved file-set straight into one folder (llama.cpp / LM Studio
  // merge multi-part `-NNNNN-of-NNNNN` GGUFs that share a directory).
  const startDirectDownload = async (files: HfGgufFile[], targetDir: string, groupName: string) => {
    const names = files.map(f => f.filename)
    if (names.length > 1) dlStore.getState().setBundleGroup(groupName, names)
    for (const f of files) {
      dlStore.getState().setMeta(f.filename, f.url, 'gguf', targetDir)
      await startModelDownloadToPath(f.url, targetDir, f.filename, f.sizeBytes || undefined)
    }
    dlStore.getState().startPolling()
  }

  const handleBundleInstall = async (bundle: ModelBundle) => {
    if (installingBundle === bundle.name) return // Prevent duplicate installs
    setInstallingBundle(bundle.name)
    setInstallError(null)
    const filenames: string[] = []
    for (const file of bundle.files) {
      if (file.downloadUrl && file.filename && file.subfolder) {
        dlStore.getState().setMeta(file.filename, file.downloadUrl, file.subfolder)
        filenames.push(file.filename)
      }
    }
    dlStore.getState().setBundleGroup(bundle.name, filenames)
    // Start polling BEFORE install so progress is tracked immediately
    dlStore.getState().startPolling()
    try {
      await installBundleComplete(bundle)
    } catch (err) {
      log.error('[DiscoverModels] Bundle install failed', { err })
      setInstallError(`${bundle.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Wait for polling to pick up at least one active download before clearing spinner
    // This prevents the "disappearing" UI — spinner stays until downloads are visible
    const waitForDownloads = () => {
      const active = filenames.some(fn => {
        const dl = dlStore.getState().downloads[fn]
        return dl && (dl.status === 'downloading' || dl.status === 'connecting' || dl.status === 'complete')
      })
      if (active) {
        setInstallingBundle(null)
      } else {
        setTimeout(waitForDownloads, 500)
      }
    }
    setTimeout(waitForDownloads, 1000)
  }

  const handleCivitaiSearch = async () => {
    if (!civitaiQuery.trim()) return
    setCivitaiSearching(true)
    setCivitaiSearched(true)
    // Reuse the CivitAI API key the user already configured for the Workflow
    // finder. The model search and the workflow finder share the same backend
    // credential, so plumbing a separate input here would just confuse users.
    const apiKey = useWorkflowStore.getState().civitaiApiKey || undefined
    const host = useWorkflowStore.getState().civitaiHost
    const results = await searchCivitaiModels(civitaiQuery, 'Checkpoint', apiKey, host)
    setCivitaiResults(results)
    setCivitaiSearching(false)
  }

  const handleCivitaiDownload = async (model: CivitAIModelResult) => {
    if (!model.downloadUrl || !model.filename || !model.subfolder) return
    dlStore.getState().setMeta(model.filename, model.downloadUrl, model.subfolder)
    await startModelDownload(model.downloadUrl, model.subfolder, model.filename)
    dlStore.getState().startPolling()
  }

  // The three card states live in lib/bundle-state.ts, pure, because bundles
  // share files and the reasoning about whose row is whose is the whole of
  // GH #113. See that file for what one shared row used to do to this list.
  const isBundleComplete = (bundle: ModelBundle): boolean =>
    bundleIsComplete(bundle.files, downloads, bundleStatuses[bundle.name] === true)

  const isBundleDownloading = (bundle: ModelBundle): boolean =>
    bundleIsDownloading(bundle.files, downloads)

  const hasBundleErrors = (bundle: ModelBundle): boolean =>
    bundleHasErrors(bundle.files, downloads, bundleStatuses[bundle.name] === true)

  const getModelDownloadState = (model: DiscoverModel): DownloadProgress | null => {
    if (!model.filename) return null
    return downloads[model.filename] ?? null
  }

  const retryBundle = (bundle: ModelBundle) => {
    // Retry only the files that are NOT complete
    for (const f of bundle.files) {
      if (!f.filename || !f.downloadUrl || !f.subfolder) continue
      const dl = downloads[f.filename]
      // Retry if: explicit error, OR no download entry and not on disk
      if (dl?.status === 'error') {
        dlStore.getState().retry(f.filename)
      } else if (!dl || (dl.status !== 'complete' && dl.status !== 'downloading' && dl.status !== 'connecting')) {
        // File has no active download — start fresh
        dlStore.getState().setMeta(f.filename, f.downloadUrl, f.subfolder)
        startModelDownload(f.downloadUrl, f.subfolder, f.filename, f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : undefined)
        dlStore.getState().startPolling()
      }
    }
  }

  // Clear (the_mr_pickles): a bundle whose download keeps failing (bad URL,
  // model pulled) was stuck on Retry with no escape — the user couldn't get it
  // out of the error state to try another model. Dismiss ALL of the bundle's
  // entries (not just errored — a partial-complete otherwise keeps
  // hasBundleErrors true) so it resets to Install.
  const clearBundle = (bundle: ModelBundle) => {
    for (const f of bundle.files) {
      if (f.filename) dlStore.getState().dismiss(f.filename)
    }
  }

  const [hfSearchResults, setHfSearchResults] = useState<DiscoverModel[]>([])

  const handleSearch = async () => {
    if (!search.trim() || !isText) return
    setLoading(true)
    try {
      const results = await searchHuggingFaceModels(search.trim())
      setHfSearchResults(results)
    } catch { /* keep existing */ }
    setLoading(false)
  }

  // The search input lives in the ModelManager header. It feeds `search`
  // (live filter) and bumps `searchSubmitToken` on Enter, which we treat as
  // "run the HuggingFace catalog search".
  useEffect(() => {
    if (searchSubmitToken > 0 && search.trim() && isText) handleSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSubmitToken])

  const uncensoredModels = isText ? getUncensoredTextModels() : []
  const mainstreamModels = isText ? getMainstreamTextModels() : []

  // Apply the size filter to text models too (Feature 46, leonsk29 GH #46).
  // We use the model's GGUF `sizeGB` as a proxy for VRAM need — Q4 quants run
  // entirely on the GPU when sizeGB ≤ VRAM, so the same bucketing as
  // image/video applies here. Models without a `sizeGB` (cloud / canPull:false
  // placeholders) bypass the filter and always show.
  const matchesVramTier = (sizeGB?: number) => {
    if (vramTier === 'all') return true
    if (sizeGB === undefined || sizeGB === null) return true
    if (vramTier === 'fit') return systemVRAM ? computeFit(sizeGB, systemVRAM) !== 'big' : true
    if (vramTier === 'ultra') return sizeGB <= 4
    if (vramTier === 'light') return sizeGB > 4 && sizeGB <= 10
    if (vramTier === 'middle') return sizeGB > 10 && sizeGB <= 20
    return sizeGB > 20 // highend (open-ended)
  }

  const matchesSearch = (m: DiscoverModel) =>
    !search ||
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.description.toLowerCase().includes(search.toLowerCase())

  const filteredUncensored = uncensoredModels.filter(m => matchesSearch(m) && matchesVramTier(m.sizeGB))
  const filteredMainstream = mainstreamModels.filter(m => matchesSearch(m) && matchesVramTier(m.sizeGB))

  // Turn a raw Ollama pull error into actionable guidance. Sharded/split GGUF
  // repos (model split into multiple .gguf parts) make `ollama pull` 400 —
  // Ollama can't pull split GGUF yet (ollama/ollama#5245). Don't show the user
  // a cryptic HTTP 400; tell them what to do.
  const formatPullError = (modelName: string, err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err)
    // Sharded / "not compatible with llama.cpp" repos genuinely can't go via
    // Ollama (ollama/ollama#5245) — point at LM Studio.
    if (isShardedOrIncompatibleGguf(msg)) {
      return `${modelName} can't be pulled into Ollama. Its HuggingFace repo is split into parts or isn't a flat single file GGUF. Download it via LM Studio instead (it loads sharded GGUF fine), or pick a single file quant.`
    }
    // A bare HTTP 400 from `ollama pull hf.co/...` is usually an OUT-OF-DATE
    // Ollama (HF-pull support is version-gated) — the same ref succeeds on
    // current Ollama. Tell the user instead of surfacing "ollama: 400"
    // (Aldrich Ironhart, Discord 2026-06-07: "Gemma 4 26B MoE → ollama: 400").
    if (/\b400\b/.test(msg)) {
      return `Ollama rejected the download of ${modelName} (HTTP 400). This is almost always an outdated Ollama. Update it from ollama.com/download and retry. Otherwise download via LM Studio, or pick a single file quant.`
    }
    return `Download failed: ${msg}`
  }

  const handleTextDownload = async (model: DiscoverModel) => {
    // Bug Y/a v2.5.0 — Aldrich Ironhart Discord. Pre-v2.5.0 we picked the
    // download backend by "whichever is enabled" with LM Studio winning when
    // both were on. That decoupled the download path from the active chat
    // picker: a user chatting on LM Studio could click Download and the
    // file would land in Ollama's store (or vice versa), invisible to the
    // chat side. Fix: derive the target backend from the *active chat
    // model*. If no active model yet (first run, brand new install), fall
    // back to the previous enabled-wins logic so the download still works.
    const activeProviderId = activeChatModel ? getProviderIdFromModel(activeChatModel) : null
    // Built-in engine lives in the managed `openai` slot. A second chat model
    // downloaded here goes flat into the app-owned models dir and boots
    // llama-server, mirroring onboarding — never nested like LM Studio.
    //
    // GH #118: the three flags below used to be read off `activeProviderId`
    // alone, so a fresh install (no chat model picked yet) matched none of
    // them and the file went down the LM Studio branch into a nested folder
    // the built-in engine never scans. resolveTextDownloadTarget keeps the
    // active-model rule and adds the missing fallback.
    const downloadTarget = resolveTextDownloadTarget({
      activeChatModel,
      openai: providers.openai,
      ollamaEnabled: !!providers.ollama?.enabled,
    })
    const isActiveBuiltin = downloadTarget === 'builtin'
    const isActiveLmStudio = downloadTarget === 'lmstudio'
    const isActiveOllama = downloadTarget === 'ollama'

    // Ollama-native models: only meaningful with Ollama present. If the user
    // is chatting on LM Studio and clicks one of these (e.g. Qwen3.6 35B
    // listed only by Ollama tag), warn instead of silently pulling into a
    // backend the user can't see from chat.
    if (model.ollamaModel) {
      const ollamaOn = !!providers.ollama?.enabled
      if (!ollamaOn) {
        setInstallError(`${model.name} only runs on Ollama. Enable the Ollama provider (Settings → Providers) before downloading.`)
        return
      }
      if (activeProviderId && !isActiveOllama) {
        setInstallError(`${model.name} can only run on Ollama. Switch the chat picker to an Ollama model first, then download.`)
        return
      }
      try {
        await pullModel(model.ollamaModel)
      } catch (e) {
        log.error('Ollama pull failed', { err: e })
        setInstallError(formatPullError(model.name, e))
      }
      return
    }
    if (!model.downloadUrl || !model.filename) return

    // Resolve the REAL file(s) on HuggingFace before downloading. The curated /
    // search-derived (url, filename) is only a *guess* — the repo may host the
    // quant in a subfolder, split it into multiple parts, or not have that
    // exact filename. Querying the tree turns the guess into the truth.
    const parsed = parseHfUrl(model.downloadUrl)
    const preferredQuant = extractGgufQuant(model.filename)
    const resolution = parsed
      ? await resolveHfGgufFiles(`${parsed.user}/${parsed.repo}`, preferredQuant)
      : null

    const lmStudioEnabled = !!providers.openai?.enabled && (providers.openai?.name || '').toLowerCase().includes('lm studio')
    const ollamaEnabledNow = !!providers.ollama?.enabled

    // Resolve the LM Studio-style destination dir for any direct download.
    // LM Studio scans <models>/<user>/<repo>/<file>.gguf and llama.cpp
    // auto-merges every `-NNNNN-of-NNNNN` part it finds in one folder.
    const ensureDirectDir = async (): Promise<string | null> => {
      // Built-in engine: flat, app-owned dir — list_bundled_models scans it
      // directly, so no <user>/<repo> nesting and no hfModelPath override
      // (that path belongs to the LM Studio flow).
      if (isActiveBuiltin) {
        return await luEngineDownloadDir()
      }
      const base = hfModelPath || (await detectProviderModelPath(providers.openai?.name || 'LM Studio'))
      if (!base) return null
      setHfModelPath(base)
      const subdir = hfUrlToLmStudioSubdir(model.downloadUrl!)
      return subdir ? `${base}/${subdir}` : base
    }

    // ── Sharded / multi-part: `ollama pull` cannot load split GGUF
    // (ollama/ollama#5245), so the only sound path is a direct multi-part
    // download into the LM Studio dir where llama.cpp merges the parts. These
    // sets are often hundreds of GB (e.g. GLM-5.1 UD-Q4_K_M = 11 files / 432 GB),
    // so we CONFIRM first — showing the part count + total size — instead of
    // silently kicking off a download the user's disk/VRAM can't sustain. ──
    if (resolution?.sharded) {
      const targetDir = await ensureDirectDir()
      if (!targetDir) {
        setInstallError('Could not determine model directory. Please check app permissions.')
        return
      }
      // The note is about Ollama's split-GGUF gap, so it must only appear when
      // Ollama really is where the user would look for the model. With the
      // built-in engine as the target the parts land in the app's own flat
      // models dir and the Rust scan collapses the set, so the note would lie.
      const ollamaCantLoad = isActiveOllama || (!isActiveBuiltin && !isActiveLmStudio && !lmStudioEnabled && ollamaEnabledNow)
      setConfirmDownload({
        name: model.name,
        files: resolution.files,
        targetDir,
        totalGB: +(resolution.totalBytes / 1_073_741_824).toFixed(1),
        note: ollamaCantLoad
          ? `Ollama can't load split GGUF (#5245). The parts go to your LM Studio models folder. Load it from LM Studio, or pick a single file quant for Ollama.`
          : undefined,
      })
      return
    }

    // ── Single file. Use the resolved file when available (it corrects a wrong
    // guessed name / subfolder); else fall back to the guess so a transient HF
    // API outage doesn't block the download. ──
    const single = resolution?.files[0]
    const realUrl = single?.url || model.downloadUrl
    const realName = single?.filename || model.filename
    const realBytes = single?.sizeBytes || (model.sizeGB ? Math.round(model.sizeGB * 1_073_741_824) : undefined)

    // Route by the active chat model. If neither side has an active model yet
    // (first launch), fall back to the old enabled-wins logic.
    const useOllamaPath = isActiveOllama

    if (useOllamaPath) {
      const ref = hfUrlToOllamaRef(realUrl, realName)
      if (!ref) {
        setInstallError(`Cannot map ${model.name} to an Ollama HF reference. Try LM Studio.`)
        return
      }
      try {
        await pullModel(ref)
      } catch (e) {
        log.error('Ollama HF pull failed', { err: e })
        setInstallError(formatPullError(model.name, e))
      }
      return
    }

    const targetDir = await ensureDirectDir()
    if (!targetDir) {
      setInstallError('Could not determine model directory. Please check app permissions.')
      return
    }
    // A vision GGUF carries no image tower: llama.cpp reads it from a separate
    // mmproj file that has to sit in the model folder BEFORE the server starts,
    // or the model silently loads text-only. It goes down the same path as the
    // model, so progress, pause, resume and retry work on it unchanged.
    const plan = planModelDownload(model, realUrl, realName, realBytes)
    try {
      if (plan.length > 1) {
        dlStore.getState().setBundleGroup(model.group || model.name, plan.map(f => f.filename))
      }
      for (const f of plan) {
        dlStore.getState().setMeta(f.filename, f.url, 'gguf', targetDir)
        await startModelDownloadToPath(f.url, targetDir, f.filename, f.expectedBytes)
      }
      dlStore.getState().startPolling()
      if (isActiveBuiltin) {
        // Built-in engine: await the flat GGUF, then make it the active chat
        // model so the freshly-added model is chat-ready without a manual switch.
        // The projector is awaited too: booting before it lands would bring the
        // model up text-only and the image button would lie.
        //
        // T-69: das Warten ist ein Abonnement auf den Download-Store, kein
        // eigener Timer — siehe `awaitDownloadedFile` oben. Ein zweiter Klick
        // bricht das Warten des ersten ab, statt zwei Warteschlangen auf
        // dieselbe Datei zu legen.
        installWaitRef.current?.abort()
        const wait = new AbortController()
        installWaitRef.current = wait
        setInstallNotice(null)
        for (const f of plan) {
          const outcome = await awaitDownloadedFile(dlStore, f.filename, wait.signal)
          if (outcome === 'complete') continue
          // Jeder andere Ausgang ist eine Entscheidung des Nutzers (Pause,
          // Abbruch) oder das Ende der Ansicht. Keiner davon ist ein Fehler,
          // und keiner darf spaeter noch eine Engine hochfahren.
          if (outcome === 'paused') {
            setInstallNotice(`Download paused, so the chat model was not switched. Resume ${f.filename} to finish it.`)
          } else if (outcome === 'cancelled') {
            setInstallNotice('Download cancelled, so the chat model was not switched.')
          }
          return
        }
        // The downloaded file becomes the active chat model through the
        // picker's own activation (lib/bundled-download-activation): the
        // engine path comes from the model list, the picker follows, and the
        // first message goes to the model the user just fetched instead of
        // swapping the engine back to the previous one.
        try {
          await activateDownloadedBundledModel({ filename: realName, refresh: fetchModels, activate: setActiveModel })
        } catch (e) {
          setInstallError(`Model downloaded, but the LU Engine failed to start: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // Outside the built-in branch too: an LM Studio or openai-compat download
      // lands in a folder the next model refresh reads, and until something
      // asks for that refresh the tile keeps offering Get for a file that is
      // already on the disk. That is the badge half of GH #118 wearing another
      // backend's clothes.
      window.dispatchEvent(new CustomEvent('lu-models-refresh'))
    } catch (e) {
      log.error('GGUF download failed', { err: e })
      setInstallError(`Download failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Derived view data for the tile grid ─────────────────────────────

  const activeTextModels = subTab === 'uncensored' ? filteredUncensored : filteredMainstream
  const textGroups = isText ? groupModels(activeTextModels) : []

  // "Start here" — up to 3 derived picks for the current tab. Pure derivation
  // from existing flags (hot/agent/lightweight) + the hardware fit; no new
  // catalog data and no picks while searching or filtering.
  const showPicks = isText && !search && vramTier === 'all' && textGroups.length > 4
  const scoredGroups = showPicks
    ? [...textGroups]
        .map(g => {
          const rep = pickDefaultVariant(g, systemVRAM, isModelFullyInstalled, getModelDownloadState)
          let score = 0
          if (rep.hot) score += 2
          if (rep.agent) score += 1
          const fit = computeFit(rep.sizeGB, systemVRAM)
          if (fit === 'fits') score += 2
          else if (fit === 'tight') score += 1
          if (!systemVRAM && rep.lightweight) score += 2
          if (rep.canPull === false) score -= 2
          if (isModelFullyInstalled(rep)) score -= 3
          return { g, score }
        })
        .sort((a, b) => b.score - a.score)
    : []
  const topPicks = showPicks ? scoredGroups.slice(0, 3).filter(s => s.score > 1).map(s => s.g) : []
  const pickKeys = new Set(topPicks.map(g => g[0].group ?? g[0].name))
  const gridGroups = textGroups.filter(g => !pickKeys.has(g[0].group ?? g[0].name))

  const infoRepoUrl = (m: DiscoverModel): string | null => {
    if (m.url) return m.url
    if (m.downloadUrl) {
      const p = parseHfUrl(m.downloadUrl)
      if (p) return `https://huggingface.co/${p.user}/${p.repo}`
    }
    return null
  }

  const renderTile = (group: DiscoverModel[], i: number, highlight = false) => (
    <motion.div
      key={group[0].group ?? group[0].name}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(i, 12) * 0.025 }}
    >
      <ModelTile
        variants={group}
        vramGb={systemVRAM}
        isInstalled={isModelFullyInstalled}
        dlState={getModelDownloadState}
        onDownload={handleTextDownload}
        onUse={handleUseInstalled}
        canUse={canUseInstalled}
        isUsing={(m) => installedEntryFor(m)?.name === usingModel && usingModel !== null}
        onInfo={setInfoModel}
        onOpenUrl={(u) => openExternal(u)}
        highlight={highlight}
      />
    </motion.div>
  )

  return (
    <div className="space-y-4">
      {/* Filter bar: Unfiltered/Mainstream + size chips + hardware chip */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className={SEGMENT_TRACK} role="group" aria-label="Catalogue">
          <button
            onClick={() => setSubTab('mainstream')}
            aria-pressed={subTab === 'mainstream'}
            title="Popular models with tool calling + vision"
            className="lu-control"
          >
            <ShieldCheck size={ICON_SM} /> Mainstream
          </button>
          <button
            onClick={() => setSubTab('uncensored')}
            aria-pressed={subTab === 'uncensored'}
            title="No filters, no limits"
            className="lu-control"
          >
            <Unlock size={ICON_SM} /> Unfiltered
          </button>
        </div>

        <div className="ml-auto">
          <HardwareChip vramGb={systemVRAM} ramGb={ramGb} />
        </div>
      </div>

      {/* Size chips — same buckets as the old VRAM-tier filter, plain labels */}
      {(isImage || isVideo || (isText && (uncensoredModels.length > 0 || mainstreamModels.length > 0))) && (
        <div className={SEGMENT_TRACK} role="group" aria-label="Size">
          {([
            { key: 'all' as SizeTier, label: 'All', desc: '' },
            ...(systemVRAM ? [{ key: 'fit' as SizeTier, label: 'Fits my PC', desc: `≤${systemVRAM} GB` }] : []),
            { key: 'ultra' as SizeTier, label: 'Tiny', desc: '≤4 GB' },
            { key: 'light' as SizeTier, label: 'Small', desc: '4 to 10 GB' },
            { key: 'middle' as SizeTier, label: 'Medium', desc: '10 to 20 GB' },
            { key: 'highend' as SizeTier, label: 'Big', desc: '>20 GB' },
          ]).map(tier => (
            <button
              key={tier.key}
              onClick={() => setVramTier(tier.key)}
              aria-pressed={vramTier === tier.key}
              className="lu-control"
            >
              {tier.label}
              {tier.desc && <span className="opacity-60 ml-1">{tier.desc}</span>}
            </button>
          ))}
        </div>
      )}

      {/* A14: the pick took the chat backend with it, and says so. The same
          bar the composer shows, from the same store, so the sentence cannot
          drift into two versions of itself. */}
      <LuEngineSwitchBar />

      {/* D-S22 · die Legende zu den Faehigkeitszeichen auf den Kacheln.
          Steht einmal hier statt 53 Mal als Tooltip, den man erst findet,
          wenn man auf einem 12px-Glyph stehenbleibt. Sie rendert aus
          derselben `CAPABILITIES`-Tabelle wie die Kacheln (ModelTiles.tsx),
          kann also nicht von ihnen abweichen. Sie steht unter der Leiste,
          also so nah wie moeglich an dem Raster, das sie erklaert. */}
      {isText && (uncensoredModels.length > 0 || mainstreamModels.length > 0) && (
        <CapLegend />
      )}

      {/* Install error banner */}
      {installError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <XCircle size={16} className="shrink-0" />
          <span className="flex-1">{installError}</span>
          <button onClick={() => setInstallError(null)} className="text-red-400 hover:text-red-300 shrink-0">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Install notice — T-69. Nicht rot: eine Pause ist keine Panne. */}
      {installNotice && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] text-gray-600 dark:text-gray-300 text-sm">
          <Info size={ICON_SM} className="shrink-0" />
          <span className="flex-1">{installNotice}</span>
          <button
            onClick={() => setInstallNotice(null)}
            className="lu-control lu-control--icon shrink-0"
            aria-label="Dismiss this notice"
          >
            <X size={ICON_SM} />
          </button>
        </div>
      )}

      {/* Image / Video bundles */}
      {(isImage || isVideo) && filteredBundles.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {filteredBundles.map((bundle, bi) => (
            <motion.div key={bundle.name} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(bi, 12) * 0.025 }}>
              <BundleTile
                bundle={bundle}
                vramGb={systemVRAM}
                complete={isBundleComplete(bundle)}
                downloading={isBundleDownloading(bundle) || installingBundle === bundle.name}
                hasErrors={hasBundleErrors(bundle)}
                onInstall={() => handleBundleInstall(bundle)}
                onRetry={() => retryBundle(bundle)}
                onClear={() => clearBundle(bundle)}
                onOpenUrl={(u) => openExternal(u)}
              />
            </motion.div>
          ))}
        </div>
      )}

      {(isImage || isVideo) && sortedBundles.length > 0 && filteredBundles.length === 0 && (
        <p className="text-center text-gray-500 py-4 text-sm">No models match this size filter. Try a different one.</p>
      )}

      {/* CivitAI Search (Image & Video) */}
      {(isImage || isVideo) && (
        <GlassCard className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Search CivitAI</h3>
            {/* Mirror toggle (#53) — civitai.red for regions where .com is blocked. */}
            <div className="flex items-center gap-1 t-micro">
              <span className="text-gray-400 dark:text-gray-500 mr-0.5">mirror</span>
              {(['civitai.com', 'civitai.red'] as const).map((h) => (
                <button
                  key={h}
                  onClick={() => setCivitaiHost(h)}
                  title={h === 'civitai.red'
                    ? 'Use the civitai.red mirror for regions where civitai.com is blocked'
                    : 'Use civitai.com (default)'}
                  className={
                    'px-1.5 py-0.5 rounded font-mono transition-colors ' +
                    (civitaiHost === h
                      ? 'bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white'
                      : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200')
                  }
                >
                  {h.replace('civitai', '')}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 w-full sm:w-2/3 lg:w-1/2 mx-auto">
            <input
              value={civitaiQuery}
              onChange={(e) => setCivitaiQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCivitaiSearch()}
              placeholder="e.g. flux, sdxl realistic, anime..."
              className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
            />
            <button
              onClick={handleCivitaiSearch}
              disabled={civitaiSearching || !civitaiQuery.trim()}
              className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 disabled:opacity-50 text-gray-700 dark:text-white transition-colors"
            >
              {civitaiSearching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
          </div>

          {civitaiResults.length > 0 && (
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {civitaiResults.map((model) => {
                const dlState = model.filename ? downloads[model.filename] : null
                const isDl = dlState?.status === 'downloading' || dlState?.status === 'connecting'
                const isDone = dlState?.status === 'complete'

                return (
                  <div key={model.id} className="flex gap-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
                    {model.thumbnailUrl && (
                      <img src={proxyImageUrl(model.thumbnailUrl)} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0" loading="lazy" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{model.name}</span>
                        {model.sizeGB && <span className="t-micro text-gray-400 flex-shrink-0">{model.sizeGB} GB</span>}
                      </div>
                      {model.description && <p className="t-micro text-gray-500 line-clamp-1 mt-0.5">{model.description}</p>}
                      {isDl && dlState && dlState.total > 0 && (
                        <div className="mt-1.5">
                          <ProgressBar progress={(dlState.progress / dlState.total) * 100} />
                          <span className="t-micro text-gray-400">{formatBytes(dlState.progress)} / {formatBytes(dlState.total)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isDone ? (
                        <CheckCircle size={16} className="text-green-500" />
                      ) : isDl ? (
                        <Loader2 size={16} className="animate-spin text-gray-400" />
                      ) : model.downloadUrl ? (
                        <button onClick={() => handleCivitaiDownload(model)} className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-colors" title="Download" aria-label="Download">
                          <Download size={14} />
                        </button>
                      ) : null}
                      <button onClick={() => openExternal(model.sourceUrl)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-colors" title="View on CivitAI" aria-label="View on CivitAI">
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Listen-Ladezustand 2 von 4 — dieselbe Begruendung eine Karte
              weiter oben, nur mit der Zeilengeometrie der Trefferliste. */}
          {civitaiSearching && <CivitaiResultsSkeleton />}
          {!civitaiSearching && civitaiSearched && civitaiResults.length === 0 && (
            <div className="text-center py-4 t-micro text-gray-500 leading-relaxed">
              No matches for "{civitaiQuery}". Try a broader query, or add your CivitAI API key
              in the Workflow finder for the full catalog.
            </div>
          )}
        </GlassCard>
      )}

      {/* ── D-S26 · „Keine Virtualisierung: 53 Karten = 1610 DOM-Knoten,
          300 Modelle ≈ 9000." ──────────────────────────────────────────

          Hier steht bewusst KEINE Virtualisierung und auch nicht das Mittel,
          mit dem T-11 dasselbe Problem im Transkript geloest hat
          (`content-visibility: auto` in MessageList.tsx). Beides wurde
          gemessen, bevor es verworfen wurde.

          Gezaehlt im Test (`__tests__/das-raster-zaehlt-seine-knoten.test.ts`,
          echter Katalog durch `renderToStaticMarkup`): 53 Kacheln je Reiter,
          rund 28 Elementknoten pro Kachel.

          Gemessen in der laufenden App (Chromium, Dev-Server :5273,
          1600×900, dreispaltig; erzwungenes Style+Layout ueber
          `scroller.offsetHeight`, Median aus 41 Messungen):

            53 Kacheln  · 1304 Knoten im Raster, 1595 auf der Seite · 0,2 ms
           303 Kacheln  · Kacheln geklont, ≈ 7500 Knoten            · 1,1 ms

          Dieselbe Messung mit `content-visibility: auto` +
          `contain-intrinsic-size: auto 125px` auf jeder Kachel: 0,2 ms und
          1,1 ms — unveraendert. Dafuer wuchs `scrollHeight` um rund 20 %
          (2187 → 2637 px bzw. 11367 → 13842 px), weil die Ersatzhoehe eine
          Schaetzung ist: der Rollbalken wuerde luegen, bis der Nutzer an
          jeder Kachel einmal vorbeigescrollt ist.

          Der Grund fuer den Unterschied zum Transkript: eine Nachrichtenblase
          ist ein gerendertes Markdown-Dokument (Prism-Spans, KaTeX,
          Tabellen), eine Modellkachel sind 25 Flexboxen. `content-visibility`
          spart das Layout eines Teilbaums — hier gibt es keinen, der sich zu
          sparen lohnt.

          Und die 300 aus dem Befund sind eine Hochrechnung: gleichzeitig im
          DOM stehen koennen heute der Katalog (53) plus die
          HuggingFace-Suche, und die fragt mit `limit=20` (discover.ts).
          Der Test haelt diese Obergrenze fest und wird rot, sobald der
          Katalog aus dem gemessenen Bereich herauswaechst — dann neu messen,
          nicht raten.

          Welle 3, Listen-Ladezustand 1 von 4: „Loading models..." war ein
          Satz mittig auf 32px Hoehe, wo gleich sechs bis dreiundfuenfzig
          Kacheln stehen — die Seite sprang beim Eintreffen der Liste um
          mehrere Bildschirmhoehen. Das Skelett traegt die Rastergeometrie. */}
      {loading ? (
        <ModelGridSkeleton />
      ) : isText ? (
        <>
          {/* Start here — derived picks for the active tab */}
          {topPicks.length >= 2 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 px-1">
                <Sparkles size={11} className="text-gray-400 dark:text-gray-500" />
                <h3 className="t-micro font-semibold uppercase tracking-[0.12em] text-gray-700 dark:text-gray-300">Start here</h3>
                <span className="text-[0.55rem] text-gray-400 dark:text-gray-500">picked for your PC</span>
                <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.06]" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {topPicks.map((g, i) => renderTile(g, i, true))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            {topPicks.length >= 2 && (
              <div className="flex items-center gap-1.5 px-1 pt-1">
                <h3 className="t-micro font-semibold uppercase tracking-[0.12em] text-gray-700 dark:text-gray-300">
                  {subTab === 'uncensored' ? 'All unfiltered models' : 'All mainstream models'}
                </h3>
                <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.06]" />
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {gridGroups.map((g, i) => renderTile(g, i))}
            </div>
            {activeTextModels.length === 0 && (
              <p className="text-center text-gray-500 py-4">
                {subTab === 'uncensored' ? 'No unfiltered models match your search' : 'No mainstream models match your search'}
              </p>
            )}
          </div>

          {/* HuggingFace Search Results */}
          {hfSearchResults.length > 0 && (
            <div className="space-y-1.5 mt-6">
              <div className="flex items-center gap-1.5 px-1">
                <Search size={10} className="text-gray-400" />
                <h3 className="t-micro font-semibold uppercase tracking-[0.12em] text-gray-500">HuggingFace results</h3>
                <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.06]" />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {hfSearchResults.map((model, i) => (
                  <motion.div key={model.name + i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.025 }}>
                    <ModelTile
                      variants={[model]}
                      vramGb={systemVRAM}
                      isInstalled={isModelFullyInstalled}
                      dlState={getModelDownloadState}
                      onDownload={handleTextDownload}
                      onUse={handleUseInstalled}
                      canUse={canUseInstalled}
                      isUsing={(m) => installedEntryFor(m)?.name === usingModel && usingModel !== null}
                      onInfo={setInfoModel}
                      onOpenUrl={(u) => openExternal(u)}
                    />
                  </motion.div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}

      {!loading && filteredBundles.length === 0 && filteredUncensored.length === 0 && filteredMainstream.length === 0 && (
        <p className="text-center text-gray-500 py-4">No models found</p>
      )}

      {/* Details modal — the full catalog description, tags and links */}
      <Modal open={!!infoModel} onClose={() => setInfoModel(null)} title={infoModel?.group ? `${infoModel.group}: ${infoModel.name}` : (infoModel?.name || 'Model')}>
        {infoModel && (
          <div className="space-y-3">
            <p className="text-[0.72rem] text-gray-700 dark:text-gray-200 leading-relaxed">{infoModel.description}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {infoModel.tags.map(t => (
                <span key={t} className="t-micro px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">{t}</span>
              ))}
              {infoModel.sizeGB && <span className="t-micro text-gray-400">{infoModel.sizeGB} GB</span>}
              {infoModel.pulls && <span className="t-micro text-gray-400">{infoModel.pulls} pulls</span>}
              {infoModel.released && <span className="t-micro text-gray-400">released {infoModel.released}</span>}
            </div>
            {infoRepoUrl(infoModel) && (
              <button
                onClick={() => openExternal(infoRepoUrl(infoModel)!)}
                className="flex items-center gap-1.5 t-micro text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                <ExternalLink size={11} /> View on HuggingFace
              </button>
            )}
          </div>
        )}
      </Modal>

      <Modal open={!!confirmDownload} onClose={() => setConfirmDownload(null)} title="Download split model">
        {confirmDownload && (
          <div className="space-y-3">
            <p className="text-[12px] text-gray-700 dark:text-gray-200">
              <span className="font-semibold text-gray-900 dark:text-white">{confirmDownload.name}</span> is split into{' '}
              <span className="font-semibold text-gray-900 dark:text-white">{countLabel(confirmDownload.files.length, 'file')}</span>{' '}
              totalling <span className="font-semibold text-gray-900 dark:text-white">{confirmDownload.totalGB} GB</span>.
            </p>
            <p className="text-[0.7rem] text-gray-500">
              All parts must download into one folder to load as a single model. Make sure you have the disk space, and the RAM/VRAM to actually run it.
            </p>
            {/* Beide Saetze standen in Gelb, also in der Farbe, mit der die
                App bis heute alles zwischen „gut" und „kaputt" markiert hat.
                Keiner von beiden haelt den Download auf: der erste sagt, wie
                gross das Ding ist, der zweite, in welchem Ordner die Teile
                landen. Auskunft, kein Alarm, also der ruhige Ton aus
                `lib/hinweis.ts`. Die Schriftgroesse bleibt die der beiden
                Saetze darueber, damit der Absatz eine Stimme behaelt. */}
            {confirmDownload.totalGB > 60 && (
              <p className={`text-[0.7rem] ${HINWEIS_TEXT.ruhig}`}>
                That is very large for a local model. Most consumer GPUs can't run it.
              </p>
            )}
            {confirmDownload.note && (
              <p className={`text-[0.7rem] ${HINWEIS_TEXT.ruhig}`}>{confirmDownload.note}</p>
            )}
            <div className="flex gap-2 pt-1">
              <GlowButton variant="secondary" onClick={() => setConfirmDownload(null)} className="flex-1">
                Cancel
              </GlowButton>
              <GlowButton
                onClick={() => {
                  const c = confirmDownload
                  setConfirmDownload(null)
                  startDirectDownload(c.files, c.targetDir, c.name).catch((e) => {
                    log.error('Sharded GGUF download failed', { err: e })
                    setInstallError(`Download failed: ${e instanceof Error ? e.message : String(e)}`)
                  })
                }}
                className="flex-1"
              >
                Download {confirmDownload.files.length} parts ({confirmDownload.totalGB} GB)
              </GlowButton>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
