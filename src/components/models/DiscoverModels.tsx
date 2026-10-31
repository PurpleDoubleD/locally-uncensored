import { Fragment, useCallback, useState, useEffect, useRef } from 'react'
import { chatRecommendationGroups, isBelowChatMinimum, SMALL_CHAT_MODEL_WARNING } from '../../lib/chat-model-minimum'
import { bundleIsComplete, bundleIsDownloading, bundleHasErrors } from '../../lib/bundle-state'
import { motion } from 'framer-motion'
import { Search, XCircle, Sparkles, Unlock, ShieldCheck, ExternalLink, Info } from 'lucide-react'
import { X } from 'lucide-react'
import {
  searchHuggingFaceModels,
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles,
  getUncensoredTextModels, getMainstreamTextModels,
  detectProviderModelPath, luEngineDownloadDir,
  startModelDownload,
  installBundleComplete, remoteBundleNotice, checkBundlesOnDisk, resolveHfGgufFiles, ggufRequestFor, planModelDownload,
  imagePartFor, imagePartOf, checkDownloadSpace,
  type DiscoverModel, type DownloadProgress, type ModelBundle, type HfGgufFile, type ImagePartSource, type PlannedDownload,
} from '../../api/discover'
import { startPlannedDownload } from '../../api/model-download'
import { kimiK31CatalogEntries } from '../../api/kimi-k3-catalog'
import { asOneDownload, downloadSizeGB, gbOf, imagePartFileName, includeImageInputLabel, isImagePartFile } from '../../lib/image-part'
import { sortByTier, tierGroup } from '../../lib/render/model-tier'
import { bundlesForTabAndSearch } from '../../lib/discover-bundle-search'
import { getTotalRamGb } from '../../lib/hardware'
import { vramFit } from '../../lib/vram-fit'
import { chatModelBudgetGb, sharedMemoryWording } from '../../lib/shared-memory-wording'
import { useGraphicsMemoryGb } from '../../hooks/useGraphicsMemory'
import { openExternal, isMacOS } from '../../api/backend'
import { bundleCloudTask } from '../../lib/cloud-offer'
import { forThisPlatform } from '../../lib/mlx-only-builds'
import { useModels } from '../../hooks/useModels'
import { useDownloadStore } from '../../stores/downloadStore'
import { ModelGridSkeleton } from '../layout/ViewSkeletons'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { activateDownloadedBundledModel } from '../../lib/bundled-download-activation'
import { diagnoseBuiltinEngine } from '../../api/builtin-ensure'
import type { InstalledModelLike } from '../../lib/lmstudio-match'
import { findInstalledForDiscoverModel } from '../../lib/discover-installed'
import { isBuiltinEngineEntry } from '../../lib/lmstudio-match'
import { ensureLuEngineIsChatProvider, announceLuEngineSwitch } from '../../api/lu-engine-switch'
import { LuEngineSwitchBar } from '../chat/LuEngineSwitchBar'
import { chosenTextDownloadTarget, ollamaOnlyDownloadBlock, resolveTextDownloadTarget, textDownloadTargetLabel } from '../../lib/text-download-target'
import { useUIStore } from '../../stores/uiStore'
import { mayBeStartHerePick } from '../../lib/start-here-picks'
import { modelInfoTitle } from '../../lib/model-info-title'
import { hfUrlToOllamaRef, hfUrlToLmStudioSubdir, parseHfUrl, isShardedOrIncompatibleGguf } from '../../lib/hf-to-provider'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { countLabel } from '../../lib/formatters'
import type { ModelCategory } from '../../types/models'
import { log } from '../../lib/logger'
import { groupModels, pickDefaultVariant, computeFit, modelFootprintGb } from './ModelTiles'
import { modelSkin } from './skin'
import { ICON_SM } from '../ui/icon-size'
import { CivitaiSearchPanel } from './CivitaiSearchPanel'
import { ModelFileCheck, type FileCheckSubject } from './ModelFileCheck'
import { bundleCheckTargets, chatModelCheckTargets, chatModelCheckable } from '../../lib/model-file-check'

interface Props {
  category: ModelCategory
  /** Filter query driven by the ModelManager header search input. */
  search?: string
  /** Bumped by ModelManager whenever the user submits the search (Enter). */
  searchSubmitToken?: number
}

// Size buckets stay EXACTLY the ones from the old VRAM-tier filter (the owner
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
  const [loading, setLoading] = useState(false)
  const systemVRAM = useGraphicsMemoryGb()
  const [ramGb, setRamGb] = useState<number | null>(null)
  // Mainstream is the default + first tab (2026-07-17) — Unfiltered is
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
  // Bug Y/a v2.5.0 — a user Discord. We need to know which provider
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

  // The graphics memory behind the "runs on your PC" hints comes from
  // useGraphicsMemoryGb above (detect_gpus and ComfyUI's /system_stats, best
  // wins), the same reading Create uses. RAM is asked here.
  useEffect(() => {
    getTotalRamGb().then(r => { if (r > 0) setRamGb(r) }).catch(() => {})
  }, [])
  // A Mac has one memory pool and no card. The chat lane compares a model
  // with the share of that pool a model can take, and says memory and Mac
  // where a PC reads GPU and PC (lib/shared-memory-wording.ts). On a PC
  // `chatFitGb` IS the detected card, so nothing changes there.
  const sharedMemory = isMacOS()
  const chatFitGb = chatModelBudgetGb(sharedMemory, systemVRAM, ramGb)

  // Check which bundles are REALLY installed (file size validated, not just file existence)
  const [bundleStatuses, setBundleStatuses] = useState<Record<string, boolean>>({})
  // Which bundle files are there already, so a card announces only what Get
  // will really fetch (bundles share their text encoders and VAEs).
  const [bundleFilesOnDisk, setBundleFilesOnDisk] = useState<ReadonlySet<string>>(() => new Set())
  // Memoised so the two effects below can name it as the dependency it is
  // instead of hiding it from the dep array. It only closes over `category`,
  // so its identity changes exactly when the effects had to re-run anyway —
  // no re-subscription loop.
  const refreshBundleStatuses = useCallback(() => {
    if (category !== 'image' && category !== 'video') return
    const allBundles = [...getImageBundles(), ...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles()]
    checkBundlesOnDisk(allBundles).then(({ installed, files }) => {
      setBundleStatuses(installed)
      setBundleFilesOnDisk(files)
    })
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
  // The Video tab also carries the other Create lanes (music, lip sync, motion).
  // They used to be installable only from the empty-lane starter card of Create,
  // so a second music model (YuE2 next to ACE Step) or the Wan S2V FP8 variant
  // could never be fetched once the first one was on disk. Each such tile says
  // which lane it belongs to.
  const laneOf = new Map<string, string>([
    ...getAudioBundles().map((b) => [b.name, 'Music'] as const),
    ...getLipsyncBundles().map((b) => [b.name, 'Lip sync'] as const),
    ...getMotionBundles().map((b) => [b.name, 'Motion'] as const),
  ])
  const bundles = isImage
    ? getImageBundles()
    : isVideo ? [...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles()] : []

  // How much graphics memory a bundle wants to run without offloading, from the
  // ONE rule in lib/vram-fit. The companion files name no number, their
  // download size stands in so they keep a place in the sort and the buckets.
  const parseVRAM = (b: ModelBundle): number => b.vramComfortGB ?? b.totalSizeGB
  const fitsCard = (b: ModelBundle): boolean => {
    const fit = vramFit(b, systemVRAM)
    return fit === 'fits' || fit === 'unknown'
  }

  // Sort bundles: verified first, then HOT, then fits VRAM, then by size
  // Then the tier, stable: Best on top, Older gathered at the bottom under its
  // own line, nothing hidden (2026-10-02, same rule as the cloud pickers).
  const sortedBundles = sortByTier([...bundles].sort((a, b) => {
    // Verified models always first
    if (a.verified && !b.verified) return -1
    if (!a.verified && b.verified) return 1
    // HOT models next
    if (a.hot && !b.hot) return -1
    if (!a.hot && b.hot) return 1
    if (systemVRAM) {
      const aFits = fitsCard(a)
      const bFits = fitsCard(b)
      if (aFits && !bFits) return -1
      if (!aFits && bFits) return 1
    }
    return parseVRAM(a) - parseVRAM(b)
  }))

  // A typed search looks in both tabs (lib/discover-bundle-search: FramePack,
  // filed under Unfiltered, was not found from Mainstream, Discord 15.10.2026).
  const tabFilteredBundles = bundlesForTabAndSearch(sortedBundles, subTab, search)

  // VRAM tier filtering for bundles
  const vramFilteredBundles = tabFilteredBundles.filter(b => {
    if (vramTier === 'all') return true
    const vram = parseVRAM(b)
    if (vramTier === 'fit') return vramFit(b, systemVRAM) !== 'big'
    if (vramTier === 'ultra') return vram <= 4
    if (vramTier === 'light') return vram > 4 && vram <= 10
    if (vramTier === 'middle') return vram > 10 && vram <= 20
    return vram > 20 // highend (open-ended)
  })

  const filteredBundles = vramFilteredBundles

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
  // mistake, a user's restart the second).
  const installedEntryFor = (model: DiscoverModel) =>
    findInstalledForDiscoverModel(model, downloads, installedModels as unknown as InstalledModelLike[])

  const isModelFullyInstalled = (model: DiscoverModel) => installedEntryFor(model) !== null

  // Check files and Repair (GH #113). One dialog for the page; a bundle or a
  // chat model opens it with its files.
  const [checkSubject, setCheckSubject] = useState<FileCheckSubject | null>(null)
  const canCheckModel = (model: DiscoverModel) => {
    const entry = installedEntryFor(model)
    return chatModelCheckable(model, entry, isBuiltinEngineEntry(entry))
  }
  const checkModel = (model: DiscoverModel) => setCheckSubject({
    name: model.name,
    groupName: model.group || model.name,
    load: async () => {
      const dir = await luEngineDownloadDir()
      if (!dir) throw new Error('Could not find the model folder of the LU Engine.')
      return chatModelCheckTargets(model, dir)
    },
  })
  const checkBundle = (bundle: ModelBundle) => setCheckSubject({
    name: bundle.name,
    groupName: bundle.name,
    load: async () => bundleCheckTargets(bundle.files),
  })

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
  // Where Get sends a chat model on this visit (P11, David 2026-10-30). Null
  // follows the chat model (resolveTextDownloadTarget); 'builtin' is the
  // user's choice of the LU Engine for these downloads, without switching the
  // chat model first. A button elsewhere (the Neuron tweaker) can hand it in.
  const [targetChoice, setTargetChoice] = useState<'builtin' | null>(() => useUIStore.getState().discoverTarget)
  useEffect(() => { useUIStore.getState().clearDiscoverTarget() }, [])
  // T-69: ein Controller pro Installationsversuch. Er bricht ab, wenn die
  // Ansicht verschwindet — AppShell haengt Models an `currentView === 'models'`
  // (`AppShell.tsx:955`), ein Wechsel haengt sie also wirklich ab — und wenn
  // ein neuer Versuch startet.
  const installWaitRef = useRef<AbortController | null>(null)
  useEffect(() => () => installWaitRef.current?.abort(), [])
  // Confirmation gate for multi-part (sharded) downloads — these sets routinely
  // run hundreds of GB across many files, so we never start them silently.
  const [confirmDownload, setConfirmDownload] = useState<{ model: DiscoverModel; name: string; files: HfGgufFile[]; targetDir: string; totalGB: number; part: ImagePartSource | null; note?: string } | null>(null)

  // The user's choice about the image part, per model. Empty is the default:
  // a model with image input brings its image part along. A name lands here
  // when its box in the download dialog was unticked.
  const [withoutImagePart, setWithoutImagePart] = useState<ReadonlySet<string>>(new Set())
  const wantsImagePart = (model: DiscoverModel) => !withoutImagePart.has(model.name)
  const setWantsImagePart = (model: DiscoverModel, wanted: boolean) => {
    setWithoutImagePart(prev => {
      const next = new Set(prev)
      if (wanted) next.delete(model.name)
      else next.add(model.name)
      return next
    })
  }
  // The image part of the model in the details dialog, when the catalog does
  // not name it and the repository had to be asked.
  const [infoPart, setInfoPart] = useState<{ model: string; part: ImagePartSource | null } | null>(null)

  // Download a split model: every part into one folder (llama.cpp / LM Studio
  // merge multi-part `-NNNNN-of-NNNNN` GGUFs that share a directory), and the
  // image part next to them, named after the first part, which is the path the
  // engine is started with.
  const startDirectDownload = async (files: HfGgufFile[], targetDir: string, groupName: string, part: ImagePartSource | null) => {
    const plan: PlannedDownload[] = files.map(f => ({ url: f.url, filename: f.filename, expectedBytes: f.sizeBytes || undefined, sha256: f.sha256 }))
    if (part && files[0]) {
      plan.push({ url: part.url, filename: imagePartFileName(files[0].filename), expectedBytes: part.sizeBytes, sha256: part.sha256 })
    }
    await startPlannedDownload(plan, targetDir, groupName)
  }

  const handleBundleInstall = async (bundle: ModelBundle) => {
    if (installingBundle === bundle.name) return // Prevent duplicate installs
    setInstallingBundle(bundle.name)
    setInstallError(null)
    const filenames: string[] = []
    for (const file of bundle.files) {
      if (file.downloadUrl && file.filename && file.subfolder) {
        dlStore.getState().setMeta(file.filename, file.downloadUrl, file.subfolder, undefined, {
          expectedBytes: file.sizeGB ? Math.round(file.sizeGB * 1_073_741_824) : undefined,
          sha256: file.sha256,
        })
        filenames.push(file.filename)
      }
    }
    dlStore.getState().setBundleGroup(bundle.name, filenames)
    // Start polling BEFORE install so progress is tracked immediately
    dlStore.getState().startPolling()
    try {
      const report = await installBundleComplete(bundle)
      // GH #143: a ComfyUI on another machine. Not an error, the downloads
      // run; the notice says where they go and what is left to do over there.
      if (report.remote) setInstallNotice(remoteBundleNotice(bundle.name, report.remote))
    } catch (err) {
      log.error('[DiscoverModels] Bundle install failed', { err })
      setInstallError(`${bundle.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // One poll, so the rows of the downloads that did start are in the store
    // before the card stops saying "Installing" on its own account. From here
    // the card shows what the rows say: nothing started (no space, no network,
    // cancelled) is "Get" again at once, a failed file is "Retry". The loop
    // that stood here waited for a running row and never ended without one.
    await dlStore.getState().refresh().catch(() => {})
    setInstallingBundle(null)
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

  // A model and its image part are one download: one progress, one total, and
  // complete only when both files are (lib/image-part.ts).
  const getModelDownloadState = (model: DiscoverModel): DownloadProgress | null => {
    if (!model.filename) return null
    return asOneDownload([downloads[model.filename], downloads[imagePartFileName(model.filename)]])
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
        const expectedBytes = f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : undefined
        dlStore.getState().setMeta(f.filename, f.downloadUrl, f.subfolder, undefined, { expectedBytes, sha256: f.sha256 })
        startModelDownload(f.downloadUrl, f.subfolder, f.filename, expectedBytes, f.sha256)
        dlStore.getState().startPolling()
      }
    }
  }

  // Clear: a bundle whose download keeps failing (bad URL,
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

  // Kimi K3.1 Pro kommt erst in die Liste, wenn es die Gewichte als GGUF auf
  // HF gibt und die Engine sie oeffnet (api/kimi-k3-catalog.ts). Gecacht,
  // offline oder bei einem Fehler bleibt die Liste einfach ohne.
  const [gatedTextModels, setGatedTextModels] = useState<DiscoverModel[]>([])
  useEffect(() => {
    if (!isText) return
    let live = true
    kimiK31CatalogEntries().then((entries) => { if (live) setGatedTextModels(entries) }).catch(() => {})
    return () => { live = false }
  }, [isText])

  const uncensoredModels = isText ? forThisPlatform(getUncensoredTextModels(), isMacOS()) : []
  const mainstreamModels = isText ? forThisPlatform([...getMainstreamTextModels(), ...gatedTextModels], isMacOS()) : []

  // Apply the size filter to text models too (Feature 46, GH #46).
  // We use the model's GGUF `sizeGB` as a proxy for VRAM need — Q4 quants run
  // entirely on the GPU when sizeGB ≤ VRAM, so the same bucketing as
  // image/video applies here. Models without a `sizeGB` (cloud / canPull:false
  // placeholders) bypass the filter and always show.
  const matchesVramTier = (sizeGB?: number) => {
    if (vramTier === 'all') return true
    if (sizeGB === undefined || sizeGB === null) return true
    if (vramTier === 'fit') return chatFitGb ? computeFit(sizeGB, chatFitGb) !== 'big' : true
    if (vramTier === 'ultra') return sizeGB <= 4
    if (vramTier === 'light') return sizeGB > 4 && sizeGB <= 10
    if (vramTier === 'middle') return sizeGB > 10 && sizeGB <= 20
    return sizeGB > 20 // highend (open-ended)
  }

  const matchesSearch = (m: DiscoverModel) =>
    !search ||
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.description.toLowerCase().includes(search.toLowerCase())

  // The size filter counts the image part like the tile does: it is loaded
  // next to the model, so a model that only fits without it does not fit.
  const filteredUncensored = uncensoredModels.filter(m => matchesSearch(m) && matchesVramTier(modelFootprintGb(m)))
  const filteredMainstream = mainstreamModels.filter(m => matchesSearch(m) && matchesVramTier(modelFootprintGb(m)))

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
    // (a user, Discord 2026-06-07: "Gemma 4 26B MoE → ollama: 400").
    if (/\b400\b/.test(msg)) {
      return `Ollama rejected the download of ${modelName} (HTTP 400). This is almost always an outdated Ollama. Update it from ollama.com/download and retry. Otherwise download via LM Studio, or pick a single file quant.`
    }
    return `Download failed: ${msg}`
  }

  const targetInput = {
    activeChatModel,
    openai: providers.openai,
    ollamaEnabled: !!providers.ollama?.enabled,
  }
  const followTarget = resolveTextDownloadTarget(targetInput)
  const shownTarget = chosenTextDownloadTarget(targetInput, targetChoice)
  const targetName = (t: typeof shownTarget) => textDownloadTargetLabel(t, providers.openai?.name)
  /** What a tile's Get says it fills. An entry only Ollama can pull goes
   *  there whatever was chosen (handleTextDownload). */
  const getTargetOf = (m: DiscoverModel) => (m.ollamaModel ? 'Ollama' : targetName(shownTarget))

  const handleTextDownload = async (model: DiscoverModel) => {
    // Bug Y/a v2.5.0 — a user Discord. Pre-v2.5.0 we picked the
    // download backend by "whichever is enabled" with LM Studio winning when
    // both were on. That decoupled the download path from the active chat
    // picker: a user chatting on LM Studio could click Download and the
    // file would land in Ollama's store (or vice versa), invisible to the
    // chat side. Fix: derive the target backend from the *active chat
    // model*. If no active model yet (first run, brand new install), fall
    // back to the previous enabled-wins logic so the download still works.
    // Built-in engine lives in the managed `openai` slot. A second chat model
    // downloaded here goes flat into the app-owned models dir and boots
    // llama-server, mirroring onboarding — never nested like LM Studio.
    //
    // GH #118: the three flags below used to be read off the active provider
    // alone, so a fresh install (no chat model picked yet) matched none of
    // them and the file went down the LM Studio branch into a nested folder
    // the built-in engine never scans. resolveTextDownloadTarget keeps the
    // active-model rule and adds the missing fallback.
    const downloadTarget = chosenTextDownloadTarget(targetInput, targetChoice)
    // Chosen against the chat model: the file goes to the LU Engine, and the
    // chat stays on the model the user is talking to.
    const keepChatModel = downloadTarget === 'builtin' && resolveTextDownloadTarget(targetInput) !== 'builtin'
    const isActiveBuiltin = downloadTarget === 'builtin'
    const isActiveLmStudio = downloadTarget === 'lmstudio'
    const isActiveOllama = downloadTarget === 'ollama'

    // Ollama-native models land in Ollama whatever the picker holds.
    if (model.ollamaModel) {
      const blocked = ollamaOnlyDownloadBlock(model.name, !!providers.ollama?.enabled)
      if (blocked) {
        setInstallError(blocked)
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
    setInstallNotice(null)

    // Resolve the REAL file(s) on HuggingFace before downloading. The curated /
    // search-derived (url, filename) is only a *guess* — the repo may host the
    // quant in a subfolder, split it into multiple parts, or not have that
    // exact filename. Querying the tree turns the guess into the truth.
    //
    // The file the entry names decides. The quant is only the fallback for a
    // name the repo does not carry: on its own it cannot tell two families in
    // one repo apart, and it reads nothing from `-0731.gguf` or `_K_P.gguf`.
    const request = ggufRequestFor(model)
    const resolution = request
      ? await resolveHfGgufFiles(request.repoId, request.preferredQuant, request.exactPath)
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
        model,
        name: model.name,
        files: resolution.files,
        targetDir,
        totalGB: +(resolution.totalBytes / 1_073_741_824).toFixed(1),
        part: imagePartFor(model, resolution),
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
    // A GGUF carries no image tower: llama.cpp reads it from a second file that
    // has to lie next to the model BEFORE the server starts, or the model
    // loads without image input. It is part of the same download: one entry
    // in the download list, one progress, one total, and pause, resume, retry
    // and cancel act on both.
    const part = imagePartFor(model, resolution)
    let withPart = !!part && wantsImagePart(model)
    try {
      // Little room on the drive: when model plus image part do not fit and
      // the model alone does, the model comes without it rather than not at
      // all, and the line under the list says so. The part can be added from
      // the installed model later.
      if (withPart && part?.sizeBytes && realBytes) {
        const [both, alone] = await Promise.all([
          checkDownloadSpace({ destDir: targetDir }, realBytes + part.sizeBytes),
          checkDownloadSpace({ destDir: targetDir }, realBytes),
        ])
        if (both && !both.fits && alone?.fits) {
          withPart = false
          setInstallNotice(`${model.name} is downloading without image input: the drive has no room for the extra ${gbOf(part.sizeBytes)} GB. You can add it later under Installed.`)
        }
      }
      const plan = planModelDownload(model, realUrl, realName, realBytes, single?.sha256, { part, withImagePart: withPart })
      await startPlannedDownload(plan, targetDir, model.group || model.name)
      if (isActiveBuiltin && keepChatModel) {
        setInstallNotice(`${model.name} is downloading to the LU Engine. Your chat stays on its model; the Neuron tweaker and the model list show it once it is done.`)
      } else if (isActiveBuiltin) {
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
        for (const f of plan) {
          const outcome = await awaitDownloadedFile(dlStore, f.filename, wait.signal)
          if (outcome === 'complete') continue
          // Cancelling only the image part is a choice about the part: the
          // model is still the download, and it is still switched to.
          if (outcome === 'cancelled' && isImagePartFile(f.filename)) continue
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
    ? chatRecommendationGroups(textGroups)
        .map(g => {
          const rep = pickDefaultVariant(g, chatFitGb, isModelFullyInstalled, getModelDownloadState)
          // An entry only Ollama can pull is no first pick while Ollama is
          // off (lib/start-here-picks). It stays in the list below.
          if (!mayBeStartHerePick(rep, { ollamaEnabled: !!providers.ollama?.enabled })) return { g, score: -1 }
          let score = 0
          if (rep.hot) score += 2
          if (rep.agent) score += 1
          const fit = computeFit(modelFootprintGb(rep), chatFitGb)
          if (fit === 'fits') score += 2
          else if (fit === 'tight') score += 1
          if (!chatFitGb && rep.lightweight) score += 2
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

  // The face of the page: the classic one on Windows and Linux, the redesign
  // on the Mac (skin/which.ts). It lays out and colours; what is shown and
  // what a click does is decided in this file, once, for both.
  const skin = modelSkin()

  // The image part of the model in the details dialog: the catalog's, or for
  // a model the catalog does not know, the one its repository lists. That
  // second answer needs one request, asked when the dialog opens.
  const infoImagePart: ImagePartSource | null = infoModel
    ? imagePartOf(infoModel) ?? (infoPart?.model === infoModel.name ? infoPart.part : null)
    : null
  const openInfo = (model: DiscoverModel) => {
    setInfoModel(model)
    // The same question the download asks (`ggufRequestFor`): the file the
    // entry names decides, the quant is only the fallback.
    const request = ggufRequestFor(model)
    if (imagePartOf(model) || !request || !model.filename) return
    void resolveHfGgufFiles(request.repoId, request.preferredQuant, request.exactPath).then((resolution) => {
      setInfoPart({ model: model.name, part: imagePartFor(model, resolution) })
    })
  }

  const renderTile = (group: DiscoverModel[], i: number, highlight = false) => (
    <motion.div
      key={group[0].group ?? group[0].name}
      className={skin.cls.tileWrap}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(i, 12) * 0.025 }}
    >
      <skin.ModelTile
        variants={group}
        vramGb={chatFitGb}
        sharedMemory={sharedMemory}
        isInstalled={isModelFullyInstalled}
        dlState={getModelDownloadState}
        onDownload={handleTextDownload}
        getTarget={getTargetOf}
        onUse={handleUseInstalled}
        canUse={canUseInstalled}
        isUsing={(m) => installedEntryFor(m)?.name === usingModel && usingModel !== null}
        onCheck={checkModel}
        canCheck={canCheckModel}
        onInfo={openInfo}
        withImagePart={wantsImagePart}
        onOpenUrl={(u) => openExternal(u)}
        highlight={highlight}
      />
    </motion.div>
  )

  return (
    <div className="space-y-4">
      {/* Filter bar: Unfiltered/Mainstream, the size chips, the hardware chip,
          the line that says a pick moved the chat backend (A14: the same bar
          the composer shows, from the same store, so the sentence cannot
          drift into two versions of itself) and the legend. What is in the
          bar is decided here; how it is laid out is the face's business: two
          rows on Windows and Linux, one row on the Mac. */}
      <skin.FilterBar
        catalogue={(
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
        )}
        // Size chips: same buckets as the old VRAM-tier filter, plain labels
        sizes={(isImage || isVideo || (isText && (uncensoredModels.length > 0 || mainstreamModels.length > 0))) && (
          <div className={SEGMENT_TRACK} role="group" aria-label="Size">
            {([
              { key: 'all' as SizeTier, label: 'All', desc: '' },
              ...(sharedMemory
                // The whole pool is what the owner knows the Mac by; the share a
                // model can take of it is the rule behind the filter.
                ? (isText && chatFitGb && ramGb ? [{ key: 'fit' as SizeTier, label: 'Fits my Mac', desc: `${Math.round(ramGb)} GB` }] : [])
                : (systemVRAM ? [{ key: 'fit' as SizeTier, label: 'Fits my PC', desc: `≤${systemVRAM} GB` }] : [])),
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
        hardware={{ vramGb: systemVRAM, ramGb, sharedMemory }}
        switchBar={<LuEngineSwitchBar />}
        // D-S22 · die Legende zu den Faehigkeitszeichen auf den Kacheln.
        // Steht einmal hier statt 53 Mal als Tooltip, den man erst findet,
        // wenn man auf einem 12px-Glyph stehenbleibt. Sie rendert aus
        // derselben `CAPABILITIES`-Tabelle wie die Kacheln (ModelTiles.tsx),
        // kann also nicht von ihnen abweichen. Sie steht unter der Leiste,
        // also so nah wie moeglich an dem Raster, das sie erklaert.
        legend={isText && (uncensoredModels.length > 0 || mainstreamModels.length > 0)}
      />

      {/* Where Get puts a chat model, and the way to choose the LU Engine
          for it (P11). Only where it is a choice: when the chat model already
          runs on the LU Engine there is nothing to pick. */}
      {isText && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 t-body text-gray-600 dark:text-gray-300" data-testid="discover-target">
          <span>Get downloads to <span className="font-semibold text-gray-900 dark:text-white" data-testid="discover-target-name">{targetName(shownTarget)}</span>{targetChoice === 'builtin' && followTarget !== 'builtin' ? ' for now.' : '.'}</span>
          {followTarget !== 'builtin' && (targetChoice === 'builtin' ? (
            <button className="lu-control" onClick={() => setTargetChoice(null)} data-testid="discover-target-follow">
              Back to {targetName(followTarget)}
            </button>
          ) : (
            <button className="lu-control" onClick={() => setTargetChoice('builtin')} data-testid="discover-target-builtin" title="The Neuron tweaker and the LU Engine only use files in the LU Engine. Your chat model stays as it is.">
              Send to LU Engine instead
            </button>
          ))}
        </div>
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
            <Fragment key={bundle.name}>
            {tierGroup(bundle) && tierGroup(bundle) !== tierGroup(filteredBundles[bi - 1] ?? {}) && (
              <skin.Head place="tier" title={tierGroup(bundle) ?? ''} />
            )}
            <motion.div className={skin.cls.tileWrap} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(bi, 12) * 0.025 }}>
              <skin.BundleTile
                bundle={bundle}
                lane={laneOf.get(bundle.name)}
                cloudTask={bundleCloudTask(isImage ? 'image' : 'video', bundle, laneOf.get(bundle.name))}
                vramGb={systemVRAM}
                sharedMemory={isMacOS()}
                complete={isBundleComplete(bundle)}
                filesOnDisk={bundleFilesOnDisk}
                downloading={isBundleDownloading(bundle) || installingBundle === bundle.name}
                hasErrors={hasBundleErrors(bundle)}
                onInstall={() => handleBundleInstall(bundle)}
                onRetry={() => retryBundle(bundle)}
                onClear={() => clearBundle(bundle)}
                onCheck={() => checkBundle(bundle)}
                onOpenUrl={(u) => openExternal(u)}
              />
            </motion.div>
            </Fragment>
          ))}
        </div>
      )}

      {(isImage || isVideo) && sortedBundles.length > 0 && filteredBundles.length === 0 && (
        <p className={skin.cls.sizeFilterEmpty}>No models match this size filter. Try a different one.</p>
      )}

      {/* CivitAI Search (Image & Video). Checkpoints here; the LoRA rail
          renders the same panel with type LORA. */}
      {(isImage || isVideo) && (
        <CivitaiSearchPanel
          modelType="Checkpoint"
          title="Search CivitAI"
          placeholder="e.g. flux, sdxl realistic, anime..."
        />
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
            <div className={skin.cls.group} role="region" aria-label="Start here">
              <skin.Head
                place="start-here"
                Icon={Sparkles}
                title="Start here"
                note={sharedMemory ? 'picked for this Mac' : 'picked for your PC'}
              />
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {topPicks.map((g, i) => renderTile(g, i, true))}
              </div>
            </div>
          )}

          <div className={skin.cls.group}>
            {topPicks.length >= 2 && (
              <skin.Head place="all" title={subTab === 'uncensored' ? 'All unfiltered models' : 'All mainstream models'} />
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {gridGroups.map((g, i) => renderTile(g, i))}
            </div>
            {activeTextModels.length === 0 && (
              <p className={skin.cls.searchEmpty}>
                {subTab === 'uncensored' ? 'No unfiltered models match your search' : 'No mainstream models match your search'}
              </p>
            )}
          </div>

          {/* HuggingFace Search Results */}
          {hfSearchResults.length > 0 && (
            <div className={`${skin.cls.group} mt-6`}>
              <skin.Head place="hf-results" Icon={Search} title="HuggingFace results" />
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {hfSearchResults.map((model, i) => (
                  <motion.div key={model.name + i} className={skin.cls.tileWrap} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.025 }}>
                    <skin.ModelTile
                      variants={[model]}
                      vramGb={chatFitGb}
                      sharedMemory={sharedMemory}
                      isInstalled={isModelFullyInstalled}
                      dlState={getModelDownloadState}
                      onDownload={handleTextDownload}
                      getTarget={getTargetOf}
                      onUse={handleUseInstalled}
                      canUse={canUseInstalled}
                      isUsing={(m) => installedEntryFor(m)?.name === usingModel && usingModel !== null}
                      onInfo={openInfo}
                      withImagePart={wantsImagePart}
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
        <p className={skin.cls.searchEmpty}>No models found</p>
      )}

      {/* Details modal — the full catalog description, tags and links */}
      <Modal open={!!infoModel} onClose={() => setInfoModel(null)} title={modelInfoTitle(infoModel)}>
        {infoModel && (
          <div className="space-y-3">
            <p className="text-[0.72rem] text-gray-700 dark:text-gray-200 leading-relaxed">{sharedMemoryWording(infoModel.description, sharedMemory)}</p>
            {isBelowChatMinimum(infoModel) && <p className="text-xs leading-relaxed text-gray-700 dark:text-gray-200">{SMALL_CHAT_MODEL_WARNING}</p>}
            <div className="flex items-center gap-1.5 flex-wrap">
              {infoModel.tags.map(t => (
                <span key={t} className="t-micro px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">{t}</span>
              ))}
              {infoModel.sizeGB && <span className="t-micro text-gray-400">{infoModel.sizeGB} GB</span>}
              {infoModel.pulls && <span className="t-micro text-gray-400">{infoModel.pulls} pulls</span>}
              {infoModel.released && <span className="t-micro text-gray-400">released {infoModel.released}</span>}
            </div>
            {/* The image part of a model that can take pictures. Ticked by
                default: it comes with the download unless the user says no,
                for instance on a drive with little room. Not shown once the
                model is installed, where adding the part is its own click. */}
            {infoImagePart && !isModelFullyInstalled(infoModel) && !getModelDownloadState(infoModel) && (
              <label className="flex items-start gap-2 text-[0.72rem] text-gray-700 dark:text-gray-200" data-testid="include-image-input">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={wantsImagePart(infoModel)}
                  onChange={(e) => setWantsImagePart(infoModel, e.target.checked)}
                />
                <span>
                  {includeImageInputLabel(infoImagePart.sizeBytes)}
                  <span className="block t-micro text-gray-500 dark:text-gray-400">
                    {wantsImagePart(infoModel)
                      ? `The download is ${downloadSizeGB(infoModel.sizeGB, infoImagePart.sizeBytes, true) ?? '?'} GB in total. With it the model can look at pictures and at the screen.`
                      : 'Without it the model answers text only. You can add it later under Installed.'}
                  </span>
                </span>
              </label>
            )}
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

      <ModelFileCheck
        subject={checkSubject}
        onClose={() => {
          setCheckSubject(null)
          // Repair may have moved files to the Trash: the cards ask the disk again.
          refreshBundleStatuses()
        }}
      />

      <Modal open={!!confirmDownload} onClose={() => setConfirmDownload(null)} title="Download split model">
        {confirmDownload && (
          <div className="space-y-3">
            <p className="text-[12px] text-gray-700 dark:text-gray-200">
              <span className="font-semibold text-gray-900 dark:text-white">{confirmDownload.name}</span> is split into{' '}
              <span className="font-semibold text-gray-900 dark:text-white">{countLabel(confirmDownload.files.length, 'file')}</span>{' '}
              totalling <span className="font-semibold text-gray-900 dark:text-white">{confirmDownload.totalGB} GB</span>.
            </p>
            <p className="text-[0.7rem] text-gray-500">
              All parts must download into one folder to load as a single model. Make sure you have the disk space, and the {sharedMemory ? 'memory' : 'RAM/VRAM'} to actually run it.
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
                That is very large for a local model. {sharedMemory ? "Most Macs can't run it." : "Most consumer GPUs can't run it."}
              </p>
            )}
            {confirmDownload.note && (
              <p className={`text-[0.7rem] ${HINWEIS_TEXT.ruhig}`}>{confirmDownload.note}</p>
            )}
            {confirmDownload.part && (
              <label className="flex items-center gap-2 text-[0.72rem] text-gray-700 dark:text-gray-200" data-testid="include-image-input">
                <input
                  type="checkbox"
                  checked={wantsImagePart(confirmDownload.model)}
                  onChange={(e) => setWantsImagePart(confirmDownload.model, e.target.checked)}
                />
                {includeImageInputLabel(confirmDownload.part.sizeBytes)}
              </label>
            )}
            <ModalActions>
              <ModalButton variant="quiet" onClick={() => setConfirmDownload(null)}>
                Cancel
              </ModalButton>
              <ModalButton
                variant="primary"
                onClick={() => {
                  const c = confirmDownload
                  setConfirmDownload(null)
                  startDirectDownload(c.files, c.targetDir, c.name, wantsImagePart(c.model) ? c.part : null).catch((e) => {
                    log.error('Sharded GGUF download failed', { err: e })
                    setInstallError(`Download failed: ${e instanceof Error ? e.message : String(e)}`)
                  })
                }}
              >
                Download {confirmDownload.files.length} parts ({downloadSizeGB(confirmDownload.totalGB, confirmDownload.part?.sizeBytes, wantsImagePart(confirmDownload.model)) ?? confirmDownload.totalGB} GB)
              </ModalButton>
            </ModalActions>
          </div>
        )}
      </Modal>
    </div>
  )
}
