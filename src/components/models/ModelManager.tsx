import { displayModelName } from '../../api/providers/registry'
import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  MessagesSquare, Images, Clapperboard,
  Sparkles, PackageOpen, Video as VideoIcon, Image as ImageIcon,
  Settings as SettingsIcon, Layers, Music,
} from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useHfLinkStore } from '../../stores/hfLinkStore'
import { useProviderStore } from '../../stores/providerStore'
import { ModelCard } from './ModelCard'
import { RemoveRefusalsDialog } from './RemoveRefusalsDialog'
import { useAbliterateStore } from '../../stores/abliterateStore'
import { downloadLine } from '../../api/abliterate'
import { prefixModelName } from '../../api/providers/model-name'
import { PullModelDialog } from './PullModelDialog'
import { DiscoverModels } from './DiscoverModels'
import { CivitaiSearchPanel } from './CivitaiSearchPanel'
import { LoraLinkPanel } from './LoraLinkPanel'
import { LORA_USE_HINT, type LoraRow } from './LoraManager'
import { LoraAddons } from './LoraAddons'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { showModel } from '../../api/ollama'
import { checkComfyConnection, refreshComfyModels } from '../../api/comfyui'
import { isMlxImageHost } from '../../api/mlx-image'
import { MacMediaLane } from './MacMediaLane'
import { MacLoraLane } from './MacLoraLane'
import { useMlxLoras } from '../../hooks/useMlxLoras'
import { modelSkin, type RailEntry } from './skin'
import { useMlxMedia } from '../../hooks/useMlxMedia'
import { backendCall } from '../../api/backend'
import { addGgufFile, customModelDirs, deleteBundledModel, stopBundledEngine } from '../../api/engine'
import { counterView } from '../../lib/inventory-counter'
import { groupInstalledByProvider, needsBackendSwitchHeading, foldedRowsSentence, LU_ENGINE_GROUP } from '../../lib/lu-engine-rows'
import { isBuiltinEngineEntry } from '../../lib/lmstudio-match'
import { externalDeleteHint, servesItsOwnFiles } from '../../lib/external-model-hint'
import { installedRowMatchesSearch } from '../../lib/model-search'
import { isLoraRow } from '../../lib/lora-rows'
import { useBuiltinEngineStatus, engineIsIdle } from '../../hooks/useBuiltinEngineStatus'
import { LuEngineSwitchBar } from '../chat/LuEngineSwitchBar'
import type { InstalledModelLike } from '../../lib/lmstudio-match'
import type { ModelCategory, AIModel } from '../../types/models'

// One category drives BOTH views (Discover + Installed) — the old split
// discoverMode/categoryFilter pair collapsed into the persisted store value.
type Mode = Extract<ModelCategory, 'text' | 'image' | 'video'>

/** The rail has one entry the store's `categoryFilter` cannot hold: LoRAs are
 *  not a fourth model category, they are the add-on files that sit beside the
 *  image models. So the rail selection is Mode PLUS that one lane, and only
 *  the three real categories are written back into the store. */
type Rail = Mode | 'lora' | 'music'

// The lanes of the rail. How an entry looks, and how the active one is
// marked, is the business of the face the page wears (skin/classic.tsx on
// Windows and Linux, skin/mac.tsx on the Mac).
const RAIL_ITEMS: { key: Mode; label: string; icon: typeof MessagesSquare }[] = [
  { key: 'text',  label: 'Chat',  icon: MessagesSquare },
  { key: 'image', label: 'Image', icon: Images },
  { key: 'video', label: 'Video', icon: Clapperboard },
]

/** The fourth rail entry, under Image and Video because that is what its files
 *  attach to. Its own item rather than a member of RAIL_ITEMS above: that list
 *  is typed on the store's category and this one is not a category. */
const LORA_RAIL = { key: 'lora' as const, label: 'LoRAs', icon: Layers }

/** The Mac's music engine (ACE-Step 1.5, commands/music.rs). Its own entry
 *  for the same reason as LoRAs, and only on the Mac: on Windows and Linux a
 *  music model is a ComfyUI checkpoint of the Image lane. */
const MUSIC_RAIL = { key: 'music' as const, label: 'Music', icon: Music }

export function ModelManager() {
  const {
    models, activeModel, setActiveModel, fetchModels, removeModel,
    categoryFilter, setCategoryFilter, inventoryLoaded, inventoryRefreshing,
  } = useModels()
  const { setView, openSettingsAt } = useUIStore()
  // A14: the refusal-removal run, if one is going. The store keeps polling
  // while it runs, whichever page is open, so leaving this page and coming
  // back finds it there without a call of its own.
  const ablStatus = useAbliterateStore((s) => s.status)
  const openRemoveRefusals = useAbliterateStore((s) => s.openDialog)
  const ablDialogOpen = useAbliterateStore((s) => s.dialogPath !== null)
  const useFinishedCopy = async (outputPath: string) => {
    await fetchModels()
    const stem = (outputPath.split(/[\\/]/).pop() ?? '').replace(/\.gguf$/i, '')
    if (stem) await setActiveModel(prefixModelName('openai', stem))
  }
  const ollamaEnabled = useProviderStore(s => s.providers.ollama.enabled)
  // A14: whether the LU Engine itself is serving the chat. Decides whether its
  // group needs a heading even when it is the only group (review 7).
  const luEngineHoldsChat = useProviderStore(s => s.providers.openai.enabled && s.providers.openai.managed === true)
  const foldedRows = useModelStore((s) => s.foldedRows)
  // A16 (A14-4a): which row's Use button is mid swap. The engine has to stop,
  // reload a GGUF that can be several gigabytes and come back healthy, and a
  // button that looks idle through all of that gets pressed again.
  const [usingModel, setUsingModel] = useState<string | null>(null)
  // Dieselbe Frage, die das Einstellungsfenster stellt, und dieselbe Antwort.
  const engineRuht = engineIsIdle(useBuiltinEngineStatus())
  const [pullOpen, setPullOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  // Gesetzt wird das aus `{ name, ...await showModel(name) }` (unten in
  // `handleInfo`), und `showModel` gibt `Record<string, unknown>` zurueck
  // (api/ollama.ts:61) — es reicht die Antwort von Ollamas /api/show
  // unveraendert durch, deren Felder je nach Modell wechseln. Genau dafuer ist
  // der Typ hier gebaut: `name` kennen wir, weil wir es selbst danebenschreiben,
  // der Rest ist `unknown`. Gelesen wird ohnehin nur `name` (Modal-Titel) und
  // das Ganze als JSON.stringify.
  const [modelInfo, setModelInfo] = useState<({ name: string } & Record<string, unknown>) | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Open on Discover by default — most opens are to find and install
  // something new. Installed is one click away in the segment control.
  const [tab, setTab] = useState<'installed' | 'discover'>('discover')

  // Header search: always visible (no hidden magnifier), live filter +
  // Enter submits the HuggingFace catalog search in Discover.
  // A button elsewhere may open Models with a search (Neurons' "Get the
  // original"): it starts the field and the catalog search once.
  const [searchQuery, setSearchQuery] = useState(() => useUIStore.getState().discoverQuery ?? '')
  const [searchSubmitToken, setSearchSubmitToken] = useState(() => (useUIStore.getState().discoverQuery ? 1 : 0))
  // That search looks for an original model: its changed versions go last.
  const [originalFor] = useState(() => { const s = useUIStore.getState(); return s.discoverOriginal ? s.discoverQuery : null })
  useEffect(() => {
    if (useUIStore.getState().discoverQuery) useUIStore.getState().clearDiscoverQuery()
  }, [])
  const searchInputRef = useRef<HTMLInputElement>(null)

  // The store still defaults categoryFilter to 'all' for legacy reasons, but
  // there is no All rail item — coerce to 'text' on mount so the user never
  // lands on an unselected state.
  useEffect(() => {
    if (categoryFilter === 'all') setCategoryFilter('text')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On the Mac, image/video models are ComfyUI-only here (MLX has no manager
  // surface yet), so the whole media lane is dead — Discover → Install rejects
  // with "ComfyUI path not set" and Installed shows a "Start ComfyUI" state that
  // can never resolve. Pin the mode to text so a persisted image/video filter
  // never lands on it, and drop the two rail items below.
  // macOS: the ComfyUI-backed media grid below is dead there (Discover → Install
  // rejects with "ComfyUI path not set"). It used to be hidden outright, which
  // left a Mac user with no model surface for media at all. The rails are back —
  // they render the MLX catalogue instead, the same one Settings drives.
  const macMlxMedia = isMlxImageHost()
  const mode: Mode =
    (categoryFilter === 'text' || categoryFilter === 'image' || categoryFilter === 'video')
      ? categoryFilter
      : 'text'
  // The LoRA lane. On Windows and Linux it is ComfyUI's loras folder. On the
  // Mac local media is MLX: there the lane is the LoRA folder of the Mac's
  // image engine (MacLoraLane), which the LoRA stack in Create reads. Until
  // that folder existed the rail was not offered on the Mac at all.
  const [extraRail, setExtraRail] = useState<'lora' | 'music' | null>(null)

  // A Hugging Face link (HfLinkInbox) opens the Chat lane of Discover, where
  // its dialog lives, whatever lane or tab was open.
  const hfLink = useHfLinkStore((s) => s.pending)
  useEffect(() => {
    if (!hfLink) return
    setExtraRail(null)
    setTab('discover')
    setCategoryFilter('text')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hfLink])
  const rail: Rail = extraRail === 'lora' ? 'lora' : extraRail === 'music' && macMlxMedia ? 'music' : mode
  const showMlxPanel = macMlxMedia && rail !== 'lora' && (rail === 'music' || mode === 'image' || mode === 'video')
  /** The Mac's own LoRA lane, in place of the ComfyUI one below. */
  const showMacLoras = macMlxMedia && rail === 'lora'
  const macLoras = useMlxLoras(macMlxMedia)
  // One reading of the Mac catalogue for the lane, the rail badges and the
  // Installed counter, so the three cannot disagree.
  const mlxMedia = useMlxMedia(macMlxMedia)
  const mlxInstalled = {
    image: mlxMedia.image.models.filter((m) => m.installed).length,
    video: mlxMedia.video.models.filter((m) => m.installed).length,
    music: mlxMedia.music.models.filter((m) => m.installed).length,
  }
  /** The Mac lane on screen, when it is one. */
  const macLane = rail === 'music' ? 'music' : mode === 'video' ? 'video' : 'image'

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // An LU Engine row is a file on disk, and the file is what the two buttons
  // on the right act on. .dan_48 (help chat, 2026-09-05, 2.6.7): the row had
  // no bin and Details asked Ollama, which knows nothing about it, so a
  // downloaded model could neither be deleted nor found.
  const luEngineFile = (m: AIModel): m is AIModel & { path: string } =>
    m.type === 'text' && isBuiltinEngineEntry(m) && 'path' in m && typeof m.path === 'string' && m.path.length > 0

  // A chat model another app serves (LM Studio, any OpenAI-compatible
  // server). Neither Ollama nor LU can delete it, and Details used to ask
  // Ollama about it and then show nothing at all.
  const externalTextModel = (m: AIModel): boolean =>
    m.type === 'text' && 'provider' in m && !isBuiltinEngineEntry(m)
    && servesItsOwnFiles(m.provider, 'providerName' in m ? m.providerName : undefined)

  const handleInfo = async (name: string) => {
    const model = models.find((m: AIModel) => m.name === name)
    if (model && luEngineFile(model)) {
      setModelInfo({ name, file: model.path, size: model.size, engine: model.providerName ?? LU_ENGINE_GROUP })
      setInfoOpen(true)
      return
    }
    if (model && externalTextModel(model)) {
      const providerName = 'providerName' in model ? model.providerName : undefined
      setModelInfo({ name, engine: providerName, deleteHint: externalDeleteHint(providerName) })
      setInfoOpen(true)
      return
    }
    try {
      const info = await showModel(name)
      setModelInfo({ name, ...info })
      setInfoOpen(true)
    } catch {
      // ignore
    }
  }

  const [deleteError, setDeleteError] = useState<string | null>(null)

  // D17: a GGUF from anywhere on the drive. The dialog picks it, the import
  // links it into the LU Engine folder, and the Installed list shows it with
  // its Use button. What happened is said in a dialog either way.
  const [ggufNote, setGgufNote] = useState<{ ok: boolean; text: string } | null>(null)
  const handleAddGguf = async () => {
    try {
      const name = await addGgufFile()
      if (!name) return
      await fetchModels()
      setTab('installed')
      setGgufNote({ ok: true, text: `${name} is now one of your LU Engine models. Find it under Installed and press Use to chat with it.` })
    } catch (e) {
      setGgufNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }
  const handleDelete = async (name: string) => {
    try {
      const model = models.find((m: AIModel) => m.name === name)
      if (model && (model.type === 'image' || model.type === 'video')) {
        // ComfyUI file model (Discord): delete the file from
        // the models tree, then rescan so the enum and the list drop it.
        // The folder the user named under Storage goes along: ComfyUI
        // lists files from it now (GH #122) and LU does not delete out of it,
        // so the backend needs it to say that instead of "was not found".
        await backendCall('delete_comfy_model', { filename: name, extraDirs: customModelDirs() })
        // Nebenbefund 2 of the R8 re-measure: the rescan below is the slow
        // part (ComfyUI re-reads its model tree, then a reachability probe,
        // two /object_info reads and a stat over every remaining file), and
        // until it landed the dialog, the row and the counter all still showed
        // a file that was already off the disk. The command above returned Ok,
        // so they can say so now. The rescan still runs and still has the last
        // word.
        setConfirmDelete(null)
        useModelStore.getState().removeInventoryModel(name)
        await refreshComfyModels().catch(() => { /* rescan is best-effort */ })
        await fetchModels()
        return
      }
      if (model && luEngineFile(model)) {
        // The loaded file is locked on Windows, so the engine is stopped first
        // when the row is the active one; the backend refuses otherwise.
        if (model.name === activeModel) await stopBundledEngine()
        await deleteBundledModel(model.path)
        setConfirmDelete(null)
        await fetchModels()
        return
      }
      await removeModel(name)
      setConfirmDelete(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
      setConfirmDelete(null)
    }
  }

  // LoRAs are ComfyUI files of type 'image' and used to sit in this list
  // between the checkpoints, with no word saying what they were and a click
  // that made one the ACTIVE image model. They have their own rail now, so
  // they leave this one. Only the LoRA lane is taken out: the VAEs, text
  // encoders and the rest of the addon folders stay exactly where they were,
  // since nothing else has a place to go to.
  const loraModels = models.filter((m: AIModel) => isLoraRow(m))
  const loraRows: LoraRow[] = loraModels.map((m) => ({ name: m.name, size: m.size ?? 0 }))
  const filteredModels = models.filter((m: AIModel) => m.type === mode && !isLoraRow(m))
  const modeMeta = RAIL_ITEMS.find(r => r.key === mode)!
  /** What the Installed counter and the Installed view are about right now. */
  const installedCount = showMacLoras
    ? macLoras.loras.length
    : rail === 'lora'
    ? loraRows.length
    : showMlxPanel ? mlxInstalled[macLane] : filteredModels.length
  // One rule for the rail badges and the Installed badge, so the two can
  // never again disagree about what an uncounted lane looks like.
  const inventoryState = { loaded: inventoryLoaded, refreshing: inventoryRefreshing }
  /** The Mac's media lanes count their own catalogue, which has its own
   *  moment of not knowing yet. */
  const mlxInventoryState = { loaded: mlxMedia.loaded, refreshing: false }
  const macMediaKey = (key: string): key is 'image' | 'video' | 'music' => macMlxMedia && (key === 'image' || key === 'video' || key === 'music')

  // d37d7bf5 + neejuh (2.5.5): "models show installed in Discover but the
  // Installed tab is empty and I can't select them." Image/video models are
  // enumerated live from ComfyUI's /object_info — when ComfyUI isn't running,
  // fetchModels gets zero of them, so the Installed section looks empty even
  // though the files are on disk (the Discover "installed" badge comes from the
  // download record, a different source — hence the mismatch). Detect that case
  // with a ONE-SHOT reachability check (never a poll — keep the app light, #70)
  // so we can show the real reason instead of a misleading "no models installed".
  const [comfyReachable, setComfyReachable] = useState<boolean | null>(null)
  const imageOrVideo = mode === 'image' || mode === 'video'
  // The LoRA lane is served by the same engine and empties for the same
  // reason, so it asks the same question and shows the same answer.
  // Never on the Mac: its LoRA lane is a folder of the app, not ComfyUI's.
  const comfyBackedLane = !showMacLoras && (rail === 'lora' || imageOrVideo)
  useEffect(() => {
    if (!(tab === 'installed' && comfyBackedLane && installedCount === 0)) return
    let alive = true
    // Reset to "probing" on every (re)check — e.g. switching image<->video, or
    // re-entering an empty mode after ComfyUI went down. Without this the prior
    // resolved value lingers and briefly shows the wrong empty state before the
    // fresh probe resolves; null makes it show "Checking ComfyUI..." each time.
    setComfyReachable(null)
    checkComfyConnection()
      .then((ok) => { if (alive) setComfyReachable(ok) })
      .catch(() => { if (alive) setComfyReachable(false) })
    return () => { alive = false }
  }, [tab, comfyBackedLane, installedCount])

  // ── Render ──────────────────────────────────────────────────────

  // The face of the page: the classic one on Windows and Linux, the redesign
  // on the Mac (skin/which.ts). It lays out and colours. Everything above
  // this line, and every handler below it, is the same for both.
  const skin = modelSkin()

  const macLoraState = { loaded: macLoras.loaded, refreshing: false }
  const railEntries: RailEntry[] = [...RAIL_ITEMS, ...(macMlxMedia ? [MUSIC_RAIL] : []), LORA_RAIL].map(({ key, label, icon }) => ({
    key,
    label,
    Icon: icon,
    active: rail === key,
    badge: macMediaKey(key)
      ? counterView(mlxInstalled[key], mlxInventoryState)
      : macMlxMedia && key === 'lora'
      ? counterView(macLoras.loras.length, macLoraState)
      : counterView(
        key === 'lora'
          ? loraRows.length
          : models.filter((m) => m.type === key && !isLoraRow(m)).length,
        inventoryState,
      ),
    onPick: () => {
      if (key === 'lora' || key === 'music') { setExtraRail(key); return }
      setExtraRail(null)
      setCategoryFilter(key)
    },
  }))
  const installedBadge = counterView(installedCount, showMacLoras ? macLoraState : showMlxPanel ? mlxInventoryState : inventoryState)

  return (
    <div className="h-full flex overflow-hidden">
      <skin.ManagerFrame
        rail={rail}
        entries={railEntries}
        onBack={() => setView('chat')}
        tab={tab}
        onTab={setTab}
        installedBadge={installedBadge}
        searchRef={searchInputRef}
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          onKeyDown: (e) => {
            if (e.key === 'Enter') { setTab('discover'); setSearchSubmitToken((t) => t + 1) }
            else if (e.key === 'Escape') setSearchQuery('')
          },
        }}
        onRefresh={() => { void fetchModels(); if (macMlxMedia) { void mlxMedia.refresh(); void macLoras.refresh() } }}
        // Pull fetches an Ollama chat model by name. On the media and LoRA
        // rails it has nothing to pull into.
        onPull={ollamaEnabled && rail === 'text' ? () => setPullOpen(true) : undefined}
        // A GGUF runs on the LU Engine, which serves the chat lane only.
        onAddFile={rail === 'text' ? () => { void handleAddGguf() } : undefined}
      >
          {/* Views */}
          {showMlxPanel && (
            <MacMediaLane
              kind={macLane}
              media={mlxMedia}
              tab={tab}
              search={searchQuery}
              onGetNew={() => setTab('discover')}
            />
          )}

          {showMacLoras && (
            <MacLoraLane
              folder={macLoras}
              tab={tab}
              search={searchQuery}
              searchSubmitToken={searchSubmitToken}
              onGetNew={() => setTab('discover')}
            />
          )}

          {!showMlxPanel && !showMacLoras && tab === 'installed' && (
            <>
              {ablStatus?.status === 'running' && !ablDialogOpen && (
                // One quiet line above the list, not the empty-state block:
                // the list stays where it was while the run goes on.
                <p data-testid="remove-refusals-strip" className="t-body text-gray-500 dark:text-gray-400 mb-2">
                  Removing refusals from {ablStatus.modelName}: {ablStatus.phaseLabel || 'starting'}
                  {ablStatus.bytes && ablStatus.total > 0 && ` (${downloadLine(ablStatus)})`}.{' '}
                  <button type="button" className="underline hover:text-gray-900 dark:hover:text-white" onClick={() => openRemoveRefusals(ablStatus.sourcePath)}>Open</button>
                </p>
              )}
              {counterView(installedCount, inventoryState).kind === 'loading' ? (
                // The empty state is the same claim the counter makes, in
                // words: you own none of these. It waits for the count for
                // the same reason (Befund 2, abnahme counter-check).
                <skin.QuietLine>Reading your installed models…</skin.QuietLine>
              ) : comfyBackedLane && installedCount === 0 && comfyReachable !== true ? (
                // comfyReachable: null = still probing, false = confirmed down.
                // Never show the misleading "no models installed" here while the
                // probe is pending — on desktop checkComfyConnection has to time
                // out when ComfyUI is down (a few seconds), and that flashed the
                // wrong message before the hint appeared (caught in desktop E2E).
                comfyReachable === null ? (
                  <skin.QuietLine>Checking ComfyUI…</skin.QuietLine>
                ) : (
                  <skin.EmptyState
                    kind="engine-down"
                    Icon={rail === 'lora' ? Layers : mode === 'video' ? VideoIcon : ImageIcon}
                    // The LoRA lane hangs off the same engine, so it gets the
                    // same state and the same sentence, with its own noun.
                    title={`Start ComfyUI to see your ${rail === 'lora' ? 'LoRA' : mode} models`}
                    // Nebenbefund 3, R8 re-measure: the sentence names a Start
                    // button that sits inside a collapsed section, and said
                    // nothing about unfolding it. The button knows the whole
                    // route, so it walks all of it: Settings, the AI Backends
                    // tab, the ComfyUI section open.
                    action={{
                      Icon: SettingsIcon,
                      label: 'Open Settings',
                      onClick: () => openSettingsAt({ tab: 'backends', section: 'comfyui' }),
                    }}
                  >
                    {rail === 'lora' ? 'LoRA' : mode === 'image' ? 'Image' : 'Video'} models are served by ComfyUI, which isn't running right now, so the ones you've downloaded can't be listed yet. Open Settings, go to AI Backends, and press Start under ComfyUI (Image &amp; Video), then come back.
                  </skin.EmptyState>
                )
              ) : rail === 'lora' ? (
                <skin.LoraManager
                  rows={searchQuery ? loraRows.filter((r) => installedRowMatchesSearch(r.name, searchQuery)) : loraRows}
                  total={loraRows.length}
                  searchQuery={searchQuery}
                  onDelete={(name) => setConfirmDelete(name)}
                  onGetNew={() => setTab('discover')}
                />
              ) : models.length === 0 ? (
                <skin.EmptyState
                  kind="nothing-installed"
                  Icon={PackageOpen}
                  title="No models installed yet"
                  action={{ Icon: Sparkles, label: 'Get new models', onClick: () => setTab('discover') }}
                >
                  Browse curated chat, image and video models and install them with one click.
                </skin.EmptyState>
              ) : filteredModels.length === 0 ? (
                <skin.EmptyState
                  kind="lane-empty"
                  Icon={modeMeta.icon}
                  title={`No ${modeMeta.label.toLowerCase()} models installed`}
                  action={{ Icon: Sparkles, label: `Get new ${modeMeta.label.toLowerCase()} models`, onClick: () => setTab('discover') }}
                />
              ) : (
                (() => {
                  const shown = searchQuery
                    ? filteredModels.filter(m => installedRowMatchesSearch(m.name, searchQuery))
                    : filteredModels
                  return (
                    <section className={skin.cls.group}>
                      <skin.Head place="installed" Icon={modeMeta.icon} title={modeMeta.label} count={shown.length} />
                      <div className="space-y-1.5">
                        {/* A14: a click on an LU Engine card can move the chat
                            backend, so the same line the composer shows stands
                            here too, from the same store. */}
                        <LuEngineSwitchBar />
                        {/* Gegenprobe G1, 04.09.2026: sobald LM Studio den
                            Steckplatz haelt, faellt `Qwen3-4B-Q4_K_M`, eine
                            echte installierte Datei des Kunden von 2,3 GB,
                            aus dieser Liste weg. Die Seite zeigte "Installed
                            11" und unter LU ENGINE vier statt fuenf Dateien,
                            ohne ein Wort. Der Waehler hatte den Satz laengst,
                            hier fehlte er, und genau hier hat der Kunde
                            gesucht. Ein Satz, zwei Leser. */}
                        {foldedRows && (
                          <p
                            data-testid="installed-folded-rows"
                            className={skin.cls.foldedRows}
                          >
                            {foldedRowsSentence(foldedRows)}
                          </p>
                        )}
                        {/* A14: grouped by the backend that serves the row, LU
                            Engine first. Its rows are listed here even while
                            Ollama or LM Studio holds the chat, and using one
                            of them moves the chat backend, so the heading says
                            whose row it is before the click. One group draws
                            no heading: there is nothing to tell apart then. */}
                        {(() => {
                          const providerGroups = groupInstalledByProvider(shown as unknown as InstalledModelLike[])
                          // One group normally draws no heading. The exception
                          // is an LU Engine group while another backend holds
                          // the chat: then the heading is not decoration, it is
                          // the warning that a click here moves the backend.
                          const showHeadings = needsBackendSwitchHeading(providerGroups.map((g) => g.label), luEngineHoldsChat ? null : LU_ENGINE_GROUP)
                          let drawn = 0
                          return providerGroups.map(({ label, models: rows }) => (
                            <div key={label} className="space-y-1.5">
                              {showHeadings && (
                                <p className={skin.cls.providerHeading}>
                                  {label}
                                </p>
                              )}
                              {(rows as unknown as AIModel[]).map((model) => {
                                const i = drawn++
                                return (
                          <motion.div
                            key={model.name}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.015 }}
                          >
                            <ModelCard
                              model={model}
                              isActive={model.name === activeModel}
                              onSelect={() => { void setActiveModel(model.name) }}
                              // The Use button the 2.6.8 notes promise on this
                              // tile. Only where the word means anything: an
                              // LU Engine row that is not already active. It
                              // fires the same call the tile click does.
                              onUse={
                                isBuiltinEngineEntry(model as unknown as InstalledModelLike)
                                  ? async () => {
                                      setUsingModel(model.name)
                                      try { await setActiveModel(model.name) } finally { setUsingModel(null) }
                                    }
                                  : undefined
                              }
                              useBusy={usingModel === model.name}
                              // Steht die Engine, darf auch die aktive Zeile
                              // wieder gestartet werden (Persona P2). Die
                              // Antwort gilt fuer die Engine, nicht fuer jede
                              // Zeile: welche davon sie bedient, entscheidet
                              // die Karte selbst.
                              engineStopped={engineRuht}
                              onDelete={() => setConfirmDelete(model.name)}
                              onInfo={() => handleInfo(model.name)}
                              // A14: where the file names its original weights
                              // and is not itself a copy the tool made.
                              onRemoveRefusals={
                                luEngineFile(model) && 'sourceRepo' in model && model.sourceRepo && !model.refusalsRemoved
                                  ? () => openRemoveRefusals(model.path)
                                  : undefined
                              }
                              infoTitle={externalTextModel(model) ? `Details. ${externalDeleteHint('providerName' in model ? model.providerName : undefined)}` : undefined}
                              canDelete={
                                // Ollama text models via the Ollama API; image/video
                                // models are ComfyUI files we can delete from disk;
                                // an LU Engine row is a GGUF LU can delete itself.
                                (ollamaEnabled && model.type === 'text' && (!('provider' in model) || model.provider === 'ollama'))
                                || model.type === 'image' || model.type === 'video'
                                || luEngineFile(model)
                              }
                            />
                          </motion.div>
                                )
                              })}
                            </div>
                          ))
                        })()}
                        {shown.length === 0 && (
                          <p className={skin.cls.installedNoMatch}>No installed {modeMeta.label.toLowerCase()} models match "{searchQuery}"</p>
                        )}
                      </div>
                    </section>
                  )
                })()
              )}
            </>
          )}

          {!showMlxPanel && !showMacLoras && tab === 'discover' && (
            rail === 'lora' ? (
              // Same panel as the checkpoint search one rail up, asked for a
              // different type. The folder a hit lands in follows from that
              // type inside searchCivitaiModels, so there is no second place
              // that decides where a LoRA is written.
              <div className={skin.cls.loraDiscover}>
                <p className={skin.cls.loraDiscoverNote}>
                  Downloads land in ComfyUI&apos;s models/loras folder. {LORA_USE_HINT}
                </p>
                <LoraLinkPanel installed={loraRows.map((r) => r.name)} />
                <LoraAddons search={searchQuery} />
                <CivitaiSearchPanel
                  modelType="LORA"
                  title="Search CivitAI for LoRAs"
                  placeholder="e.g. detail enhancer, pixel art, film grain..."
                  search={searchQuery}
                  searchSubmitToken={searchSubmitToken}
                />
              </div>
            ) : (
              <DiscoverModels
                category={mode}
                search={searchQuery}
                searchSubmitToken={searchSubmitToken}
                originalFor={originalFor}
              />
            )
          )}
      </skin.ManagerFrame>

      <PullModelDialog open={pullOpen} onClose={() => setPullOpen(false)} />

      <RemoveRefusalsDialog onUse={useFinishedCopy} onModelsChanged={async () => { await fetchModels() }} />

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete Model">
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-300 mb-3">
          Are you sure you want to delete <span className="text-gray-900 dark:text-white font-mono">{confirmDelete ? displayModelName(confirmDelete) : null}</span>?
          This removes the model file from your disk and frees the space.
        </p>
        {(() => {
          const row = models.find((m: AIModel) => m.name === confirmDelete)
          return row && luEngineFile(row) ? (
            <p className="t-micro font-mono text-gray-500 dark:text-gray-400 mb-3 break-all" data-testid="delete-file-path">{row.path}</p>
          ) : null
        })()}
        <ModalActions>
          <ModalButton variant="quiet" onClick={() => setConfirmDelete(null)}>
            Cancel
          </ModalButton>
          <ModalButton variant="danger" onClick={() => confirmDelete && handleDelete(confirmDelete)}>
            Delete
          </ModalButton>
        </ModalActions>
      </Modal>

      <Modal open={!!deleteError} onClose={() => setDeleteError(null)} title="Delete failed">
        <p className="text-[0.7rem] text-red-500 dark:text-red-400 mb-3">{deleteError}</p>
        <ModalActions>
          <ModalButton onClick={() => setDeleteError(null)}>
            Close
          </ModalButton>
        </ModalActions>
      </Modal>

      <Modal open={!!ggufNote} onClose={() => setGgufNote(null)} title={ggufNote?.ok ? 'Model added' : 'Could not add the model'}>
        <p className={ggufNote?.ok ? 't-micro text-gray-600 dark:text-gray-300 mb-3' : 't-micro text-red-500 dark:text-red-400 mb-3'}>{ggufNote?.text}</p>
        <ModalActions>
          <ModalButton onClick={() => setGgufNote(null)}>
            Close
          </ModalButton>
        </ModalActions>
      </Modal>

      <Modal open={infoOpen} onClose={() => setInfoOpen(false)} title={typeof modelInfo?.name === 'string' && modelInfo.name ? displayModelName(modelInfo.name) : 'Model Info'}>
        {typeof modelInfo?.deleteHint === 'string' && (
          <p className="t-label text-gray-700 dark:text-gray-200 mb-3">{modelInfo.deleteHint}</p>
        )}
        {modelInfo && (
          <pre className="t-micro text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-black/30 rounded-lg p-3 overflow-auto max-h-80 scrollbar-thin font-mono">
            {JSON.stringify(modelInfo, null, 2)}
          </pre>
        )}
      </Modal>
    </div>
  )
}
