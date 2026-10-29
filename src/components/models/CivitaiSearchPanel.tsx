/**
 * The CivitAI search, as one panel that is told WHAT it searches for.
 *
 * It used to sit inline in DiscoverModels with `'Checkpoint'` typed into the
 * call, which made a second kind of search (LoRAs, for the Models > LoRAs rail)
 * a copy of ninety lines of markup. The type is a prop instead: one panel, one
 * mirror toggle, one key hint, one download path, and the folder a hit lands in
 * is decided once, in `searchCivitaiModels`, from that same type.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Loader2, ExternalLink, Download, CheckCircle } from 'lucide-react'
import { checkCivitaiInstalled, civitaiInstalledInFolder, searchCivitaiModels, startCivitaiDownload, startModelDownloadToPath, type CivitAIModelResult } from '../../api/discover'
import { openExternal } from '../../api/backend'
import { useDownloadStore } from '../../stores/downloadStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { CivitaiResultsSkeleton } from '../layout/ViewSkeletons'
import { GlassCard } from '../ui/GlassCard'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'
import { proxyImageUrl } from '../../lib/privacy'

interface Props {
  /** What CivitAI is asked for, which is also what decides the target folder. */
  modelType: 'Checkpoint' | 'LORA'
  /** The heading on the card. */
  title: string
  /** Placeholder for the query field, so each lane can show its own examples. */
  placeholder: string
  /** What the ModelManager header search holds. It is copied into this card's
   *  own field, so a lane whose Get new IS this card does not drop the words
   *  the user just typed up there. */
  search?: string
  /** Bumped by ModelManager on Enter in the header search. That keypress also
   *  switches to Get new, and on this lane Get new is this card: without the
   *  token the user landed on an empty field, no hits and no message, which is
   *  exactly the silent gap the empty state below exists to close. */
  searchSubmitToken?: number
  /** The Mac's LoRA lane: narrow the search to one base model, by CivitAI's
   *  own name for it. Absent on Windows and Linux. */
  baseModel?: string
  /** The Mac's LoRA lane: the folder a hit is written into, in place of a
   *  ComfyUI models folder. Absent on Windows and Linux. */
  destDir?: string
  /** The Mac's LoRA lane: the files it has listed in `destDir`. A hit whose
   *  file is among them says Installed without asking the disk again. Absent
   *  on Windows and Linux, where the hits are checked in their ComfyUI folder. */
  installed?: readonly { name: string; sizeBytes: number }[]
}

export function CivitaiSearchPanel({ modelType, title, placeholder, search = '', searchSubmitToken = 0, baseModel, destDir, installed }: Props) {
  const [results, setResults] = useState<CivitAIModelResult[]>([])
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState(search)
  // Track whether the *latest* CivitAI search has been issued at least once,
  // so an empty-state hint can render between "before-first-search" and
  // "search returned 0 hits". Without this we fall through to the silent gap
  // A user described: empty list, no console output, looks like the
  // button did nothing.
  const [searched, setSearched] = useState(false)
  // CivitAI mirror host (#53), civitai.red for regions where .com is blocked.
  const civitaiHost = useWorkflowStore((s) => s.civitaiHost)
  const setCivitaiHost = useWorkflowStore((s) => s.setCivitaiHost)
  const downloads = useDownloadStore((s) => s.downloads)
  const dlStore = useDownloadStore
  // The hits already on disk, by id (Discord #feature-requests, 3.0.7: an
  // installed model offered Download and fetched itself a second time).
  const [onDisk, setOnDisk] = useState<Set<number>>(() => new Set())

  // Windows and Linux: each new list of hits, and every finished download, is
  // checked in the folder the download would write to.
  useEffect(() => {
    if (installed || results.length === 0) return
    let live = true
    const check = () => { void checkCivitaiInstalled(results).then((ids) => { if (live) setOnDisk(ids) }) }
    check()
    window.addEventListener('comfyui-model-downloaded', check)
    return () => { live = false; window.removeEventListener('comfyui-model-downloaded', check) }
  }, [results, installed])

  // The Mac: the lane's listing is current already, it reads itself again
  // when a download lands.
  const installedIds = useMemo(
    () => (installed ? civitaiInstalledInFolder(results, installed) : onDisk),
    [installed, results, onDisk],
  )

  // Each search is numbered. Only the newest one may write the hits and end
  // the spinner: a slow answer to an older query arriving late used to
  // replace the hits of the query now in the field.
  const searchSeq = useRef(0)

  const runSearch = async (text: string = query) => {
    if (!text.trim()) return
    const mine = ++searchSeq.current
    setSearching(true)
    setSearched(true)
    // The CivitAI API key the user configured in Settings, AI Backends,
    // CivitAI API key. The search and the download path share that one
    // credential, so there is no second input here.
    const apiKey = useWorkflowStore.getState().civitaiApiKey || undefined
    const host = useWorkflowStore.getState().civitaiHost
    const hits = baseModel || destDir
      ? await searchCivitaiModels(text, modelType, apiKey, host, { baseModel, safetensorsOnly: !!destDir })
      : await searchCivitaiModels(text, modelType, apiKey, host)
    if (mine !== searchSeq.current) return
    setResults(hits)
    setSearching(false)
  }

  // Enter in the header search. Same deal DiscoverModels has with its own
  // catalog search: the live text is only a filter, the token is the submit.
  // The typed text is taken over either way, so the field is never empty
  // after a keypress that just switched the view to this card.
  useEffect(() => {
    if (searchSubmitToken <= 0 || !search.trim()) return
    setQuery(search)
    void runSearch(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSubmitToken])

  const download = async (model: CivitAIModelResult) => {
    if (!model.downloadUrl || !model.filename || !model.subfolder) return
    if (destDir) {
      // The folder goes into the record with the file, so Retry and Resume
      // write to the same place and never look for a ComfyUI.
      dlStore.getState().setMeta(model.filename, model.downloadUrl, model.subfolder, destDir)
      await startModelDownloadToPath(model.downloadUrl, destDir, model.filename)
      dlStore.getState().startPolling()
      return
    }
    dlStore.getState().setMeta(model.filename, model.downloadUrl, model.subfolder)
    await startCivitaiDownload(model)
    dlStore.getState().startPolling()
  }

  return (
    <GlassCard className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
        {/* Mirror toggle (#53), civitai.red for regions where .com is blocked. */}
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
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch() }}
          placeholder={placeholder}
          aria-label={title}
          className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
        />
        <button
          onClick={() => { void runSearch() }}
          disabled={searching || !query.trim()}
          aria-label="Search CivitAI"
          className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 disabled:opacity-50 text-gray-700 dark:text-white transition-colors"
        >
          {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
        </button>
      </div>

      {results.length > 0 && (
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {results.map((model) => {
            const dlState = model.filename ? downloads[model.filename] : null
            const isDl = dlState?.status === 'downloading' || dlState?.status === 'connecting'
            const isDone = dlState?.status === 'complete'
            const isInstalled = installedIds.has(model.id)

            return (
              <div key={model.id} data-testid="civitai-hit" className="flex gap-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
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
                  {isInstalled ? (
                    <span className="flex items-center gap-1 px-2 t-micro text-green-700 dark:text-green-400" title="This file is already in the model folder">
                      <CheckCircle size={14} />
                      Installed
                    </span>
                  ) : isDone ? (
                    <CheckCircle size={16} className="text-green-500" />
                  ) : isDl ? (
                    <Loader2 size={16} className="animate-spin text-gray-400" />
                  ) : model.downloadUrl ? (
                    <button onClick={() => download(model)} className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-colors" title="Download" aria-label="Download">
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

      {/* Listen-Ladezustand 2 von 4: dieselbe Begruendung eine Karte weiter
          oben, nur mit der Zeilengeometrie der Trefferliste. */}
      {searching && <CivitaiResultsSkeleton />}
      {!searching && searched && results.length === 0 && (
        <div className="text-center py-4 t-micro text-gray-500 leading-relaxed">
          No matches for "{query}". Try a broader query. The full catalog needs your key,
          which you set under Settings &gt; AI Backends &gt; CivitAI API key.
        </div>
      )}
    </GlassCard>
  )
}
