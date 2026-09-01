import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Download, ArrowLeft, RefreshCw, Search, MessagesSquare, Images, Clapperboard,
  X as XIcon, HardDrive, Sparkles, PackageOpen, Video as VideoIcon, Image as ImageIcon,
  Settings as SettingsIcon,
} from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useProviderStore } from '../../stores/providerStore'
import { ModelCard } from './ModelCard'
import { PullModelDialog } from './PullModelDialog'
import { DiscoverModels } from './DiscoverModels'
import { Modal } from '../ui/Modal'
import { GlowButton } from '../ui/GlowButton'
import { showModel } from '../../api/ollama'
import { checkComfyConnection, refreshComfyModels } from '../../api/comfyui'
import { isMlxImageHost } from '../../api/mlx-image'
import { MlxMediaSettings } from '../settings/MlxMediaSettings'
import { backendCall } from '../../api/backend'
import { counterView } from '../../lib/inventory-counter'
import type { ModelCategory, AIModel } from '../../types/models'

// One category drives BOTH views (Discover + Installed) — the old split
// discoverMode/categoryFilter pair collapsed into the persisted store value.
type Mode = Extract<ModelCategory, 'text' | 'image' | 'video'>

// Monochrome on purpose — the active state is carried by the pill background,
// not by per-category accent colors (David 2026-07-17 design pass).
const RAIL_ITEMS: { key: Mode; label: string; icon: typeof MessagesSquare }[] = [
  { key: 'text',  label: 'Chat',  icon: MessagesSquare },
  { key: 'image', label: 'Image', icon: Images },
  { key: 'video', label: 'Video', icon: Clapperboard },
]

/** The mark a counter wears while it has nothing counted to show. Not a 0:
 *  a 0 next to a card that reads Installed is a wrong answer, and this one
 *  stood for five seconds on the real box (Befund 2, 2026-08-29). */
function CountingDots({ label }: { label: string }) {
  return (
    <span
      className="text-[0.55rem] font-normal opacity-50 animate-pulse"
      role="status"
      aria-label={label}
      title={label}
    >
      &middot;&middot;&middot;
    </span>
  )
}

export function ModelManager() {
  const {
    models, activeModel, setActiveModel, fetchModels, removeModel,
    categoryFilter, setCategoryFilter, inventoryLoaded, inventoryRefreshing,
  } = useModels()
  const { setView, openSettingsAt } = useUIStore()
  const ollamaEnabled = useProviderStore(s => s.providers.ollama.enabled)
  const [pullOpen, setPullOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [modelInfo, setModelInfo] = useState<any>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Open on Discover by default — most opens are to find and install
  // something new. Installed is one click away in the segment control.
  const [tab, setTab] = useState<'installed' | 'discover'>('discover')

  // Header search: always visible (no hidden magnifier), live filter +
  // Enter submits the HuggingFace catalog search in Discover.
  const [searchQuery, setSearchQuery] = useState('')
  const [searchSubmitToken, setSearchSubmitToken] = useState(0)
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
  const showMlxPanel = macMlxMedia && (mode === 'image' || mode === 'video')

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const handleInfo = async (name: string) => {
    try {
      const info = await showModel(name)
      setModelInfo({ name, ...info })
      setInfoOpen(true)
    } catch {
      // ignore
    }
  }

  const [deleteError, setDeleteError] = useState<string | null>(null)
  const handleDelete = async (name: string) => {
    try {
      const model = models.find((m: AIModel) => m.name === name)
      if (model && (model.type === 'image' || model.type === 'video')) {
        // ComfyUI file model (cpl.sardinas7489, Discord): delete the file from
        // the models tree, then rescan so the enum and the list drop it.
        await backendCall('delete_comfy_model', { filename: name })
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
      await removeModel(name)
      setConfirmDelete(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
      setConfirmDelete(null)
    }
  }

  const filteredModels = models.filter((m: AIModel) => m.type === mode)
  const modeMeta = RAIL_ITEMS.find(r => r.key === mode)!
  // One rule for the rail badges and the Installed badge, so the two can
  // never again disagree about what an uncounted lane looks like.
  const inventoryState = { loaded: inventoryLoaded, refreshing: inventoryRefreshing }

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
  useEffect(() => {
    if (!(tab === 'installed' && imageOrVideo && filteredModels.length === 0)) return
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
  }, [tab, imageOrVideo, filteredModels.length])

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="h-full flex overflow-hidden">
      {/* Category rail — the big, labeled home of Chat / Image / Video */}
      <aside className="shrink-0 w-12 lg:w-36 border-r border-gray-200 dark:border-white/[0.06] bg-gray-50/60 dark:bg-white/[0.015] flex flex-col py-3 px-1.5 lg:px-2 gap-1">
        {RAIL_ITEMS.map(({ key, label, icon: Icon }) => {
          const active = mode === key
          const badge = counterView(models.filter((m) => m.type === key).length, inventoryState)
          return (
            <button
              key={key}
              onClick={() => setCategoryFilter(key)}
              title={label}
              aria-pressed={active}
              className={`flex items-center justify-center lg:justify-start gap-2 px-2 py-2 rounded-lg transition-colors ${
                active
                  ? 'bg-white dark:bg-white/[0.08] shadow-sm border border-gray-200 dark:border-white/[0.08]'
                  : 'border border-transparent hover:bg-gray-100 dark:hover:bg-white/[0.04]'
              }`}
            >
              <Icon size={15} className={active ? 'text-gray-800 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'} />
              <span className={`hidden lg:block text-[0.68rem] font-medium ${active ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
                {label}
              </span>
              {badge.kind === 'loading' ? (
                <span className="hidden lg:block ml-auto">
                  <CountingDots label={`Counting installed ${label.toLowerCase()} models`} />
                </span>
              ) : badge.value > 0 ? (
                <span className="hidden lg:block ml-auto text-[0.55rem] text-gray-400 dark:text-gray-500 tabular-nums">{badge.value}</span>
              ) : null}
            </button>
          )
        })}
        <div className="mt-auto hidden lg:block px-2 pb-1 text-[0.5rem] leading-relaxed text-gray-400 dark:text-gray-600">
          Models run 100% on your computer.
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
        {/* Full pane width like the chat area — no centered max-w cap, so wide
            windows get more grid columns instead of side gutters. */}
        <div className="p-4 space-y-4">
          {/* Top bar */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView('chat')}
              className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              title="Back to chat"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="text-[0.85rem] font-semibold text-gray-900 dark:text-white">Models</h1>

            {/* Discover / Installed segment — the MLX panel is one list with
                per-model Install/Remove, so the split would switch nothing. */}
            <div className={`ml-2 flex items-center p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] ${showMlxPanel ? 'hidden' : ''}`}>
              <button
                onClick={() => setTab('discover')}
                aria-pressed={tab === 'discover'}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.62rem] font-semibold transition-colors ${
                  tab === 'discover'
                    ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Sparkles size={11} /> Get new
              </button>
              <button
                onClick={() => setTab('installed')}
                aria-pressed={tab === 'installed'}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.62rem] font-semibold transition-colors ${
                  tab === 'installed'
                    ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <HardDrive size={11} /> Installed
                {(() => {
                  const badge = counterView(filteredModels.length, inventoryState)
                  return badge.kind === 'loading' ? (
                    <CountingDots label="Counting installed models" />
                  ) : (
                    <span className="text-[0.55rem] font-normal opacity-70 tabular-nums">{badge.value}</span>
                  )
                })()}
              </button>
            </div>

            <div className="flex-1" />

            {/* Always-visible search */}
            <div className="relative w-40 sm:w-56">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { setTab('discover'); setSearchSubmitToken((t) => t + 1) }
                  else if (e.key === 'Escape') setSearchQuery('')
                }}
                placeholder="Search models…"
                className="w-full pl-7 pr-6 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <XIcon size={11} />
                </button>
              )}
            </div>

            <button onClick={fetchModels} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors" title="Refresh">
              <RefreshCw size={13} />
            </button>
            {ollamaEnabled && (
              <button
                onClick={() => setPullOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.62rem] text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                title="Pull any Ollama model by name"
              >
                <Download size={11} /> Pull
              </button>
            )}
          </div>

          {/* Views */}
          {showMlxPanel && (
            <div className="pt-1">
              <MlxMediaSettings only={mode === 'image' ? 'image' : 'video'} />
            </div>
          )}

          {!showMlxPanel && tab === 'installed' && (
            <>
              {counterView(filteredModels.length, inventoryState).kind === 'loading' ? (
                // The empty state is the same claim the counter makes, in
                // words: you own none of these. It waits for the count for
                // the same reason (Befund 2, abnahme counter-check).
                <div className="text-center py-16 px-6">
                  <p className="text-[0.7rem] text-gray-500">Reading your installed models…</p>
                </div>
              ) : imageOrVideo && filteredModels.length === 0 && comfyReachable !== true ? (
                // comfyReachable: null = still probing, false = confirmed down.
                // Never show the misleading "no models installed" here while the
                // probe is pending — on desktop checkComfyConnection has to time
                // out when ComfyUI is down (a few seconds), and that flashed the
                // wrong message before the hint appeared (caught in desktop E2E).
                comfyReachable === null ? (
                  <div className="text-center py-16 px-6">
                    <p className="text-[0.7rem] text-gray-500">Checking ComfyUI…</p>
                  </div>
                ) : (
                <div className="flex flex-col items-center justify-center text-center py-16 px-6 gap-3">
                  <div className="w-14 h-14 rounded-full bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] flex items-center justify-center">
                    {mode === 'video' ? <VideoIcon size={22} className="text-gray-400 dark:text-gray-500" /> : <ImageIcon size={22} className="text-gray-400 dark:text-gray-500" />}
                  </div>
                  <div className="space-y-1">
                    <p className="text-[12px] font-medium text-gray-800 dark:text-gray-200">Start ComfyUI to see your {mode} models</p>
                    <p className="text-[0.6rem] text-gray-500 max-w-[300px] leading-relaxed">
                      {mode === 'image' ? 'Image' : 'Video'} models are served by ComfyUI, which isn't running right now, so the ones you've downloaded can't be listed yet. Open Settings, go to AI Backends, and press Start under ComfyUI (Image &amp; Video), then come back.
                    </p>
                  </div>
                  {/* Nebenbefund 3, R8 re-measure: the sentence above names a
                      Start button that sits inside a collapsed section, and
                      said nothing about unfolding it. The button knows the
                      whole route, so it walks all of it: Settings, the AI
                      Backends tab, the ComfyUI section open. */}
                  <button
                    onClick={() => openSettingsAt({ tab: 'backends', section: 'comfyui' })}
                    className="flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-md bg-gray-900 dark:bg-white/10 hover:bg-gray-800 dark:hover:bg-white/15 text-white text-[0.65rem] font-medium transition-colors"
                  >
                    <SettingsIcon size={11} /> Open Settings
                  </button>
                </div>
                )
              ) : models.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-16 px-6 gap-3">
                  <div className="w-14 h-14 rounded-full bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] flex items-center justify-center">
                    <PackageOpen size={22} className="text-gray-400 dark:text-gray-500" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-[12px] font-medium text-gray-800 dark:text-gray-200">No models installed yet</p>
                    <p className="text-[0.6rem] text-gray-500 max-w-[280px] leading-relaxed">
                      Browse curated chat, image and video models and install them with one click.
                    </p>
                  </div>
                  <button
                    onClick={() => setTab('discover')}
                    className="flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-md bg-gray-900 dark:bg-white/10 hover:bg-gray-800 dark:hover:bg-white/15 text-white text-[0.65rem] font-medium transition-colors"
                  >
                    <Sparkles size={11} /> Discover models
                  </button>
                </div>
              ) : filteredModels.length === 0 ? (
                <div className="text-center py-10 space-y-2">
                  <p className="text-[0.7rem] text-gray-500">
                    No {modeMeta.label.toLowerCase()} models installed
                  </p>
                  <button
                    onClick={() => setTab('discover')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                  >
                    <Sparkles size={11} /> Discover {modeMeta.label.toLowerCase()} models
                  </button>
                </div>
              ) : (
                (() => {
                  const SectionIcon = modeMeta.icon
                  const shown = searchQuery
                    ? filteredModels.filter(m => m.name.toLowerCase().includes(searchQuery.toLowerCase()))
                    : filteredModels
                  return (
                    <section className="space-y-1.5">
                      <div className="flex items-center gap-2 px-1">
                        <SectionIcon size={11} />
                        <h2 className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-gray-700 dark:text-gray-300">
                          {modeMeta.label}
                        </h2>
                        <span className="text-[0.55rem] text-gray-400 dark:text-gray-500 tabular-nums">{shown.length}</span>
                        <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.06]" />
                      </div>
                      <div className="space-y-1.5">
                        {shown.map((model, i) => (
                          <motion.div
                            key={model.name}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.015 }}
                          >
                            <ModelCard
                              model={model}
                              isActive={model.name === activeModel}
                              onSelect={() => setActiveModel(model.name)}
                              onDelete={() => setConfirmDelete(model.name)}
                              onInfo={() => handleInfo(model.name)}
                              canDelete={
                                // Ollama text models via the Ollama API; image/video
                                // models are ComfyUI files we can delete from disk.
                                (ollamaEnabled && model.type === 'text' && (!('provider' in model) || model.provider === 'ollama'))
                                || model.type === 'image' || model.type === 'video'
                              }
                            />
                          </motion.div>
                        ))}
                        {shown.length === 0 && (
                          <p className="text-center text-[0.65rem] text-gray-500 py-6">No installed {modeMeta.label.toLowerCase()} models match "{searchQuery}"</p>
                        )}
                      </div>
                    </section>
                  )
                })()
              )}
            </>
          )}

          {!showMlxPanel && tab === 'discover' && (
            <DiscoverModels
              category={mode}
              search={searchQuery}
              searchSubmitToken={searchSubmitToken}
            />
          )}
        </div>
      </div>

      <PullModelDialog open={pullOpen} onClose={() => setPullOpen(false)} />

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete Model">
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-300 mb-3">
          Are you sure you want to delete <span className="text-gray-900 dark:text-white font-mono">{confirmDelete}</span>?
          This removes the model file from your disk and frees the space.
        </p>
        <div className="flex gap-2">
          <GlowButton variant="secondary" onClick={() => setConfirmDelete(null)} className="flex-1">
            Cancel
          </GlowButton>
          <GlowButton variant="danger" onClick={() => confirmDelete && handleDelete(confirmDelete)} className="flex-1">
            Delete
          </GlowButton>
        </div>
      </Modal>

      <Modal open={!!deleteError} onClose={() => setDeleteError(null)} title="Delete failed">
        <p className="text-[0.7rem] text-red-500 dark:text-red-400 mb-3">{deleteError}</p>
        <GlowButton variant="secondary" onClick={() => setDeleteError(null)} className="w-full">
          Close
        </GlowButton>
      </Modal>

      <Modal open={infoOpen} onClose={() => setInfoOpen(false)} title={modelInfo?.name || 'Model Info'}>
        {modelInfo && (
          <pre className="text-[0.6rem] text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-black/30 rounded-lg p-3 overflow-auto max-h-80 scrollbar-thin font-mono">
            {JSON.stringify(modelInfo, null, 2)}
          </pre>
        )}
      </Modal>
    </div>
  )
}
