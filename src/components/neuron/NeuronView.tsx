import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RotateCcw, Search, Sliders, Trash2 } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { ICON_SM } from '../ui/icon-size'
import { openExternal } from '../../api/backend'
import { listBundledModels, bundledEngineStatus, isEmbeddingGgufName, type BundledModel } from '../../api/engine'
import {
  neuronApply, neuronBuildOwn, neuronBuildPreset, neuronCancel, neuronCompare, neuronDelete, neuronDismiss,
  neuronFeatureAdd, neuronInfo, neuronPresets, neuronSaeDownload, neuronSaeSearch, neuronStatus,
  type CompareResult, type FeatureHit, type NeuronInfo, type NeuronJob, type NeuronPreset, type NeuronVector,
} from '../../api/neuron'
import { getProviderIdFromModel } from '../../api/providers/model-name'
import { isManagedBuiltinSlot } from '../../api/builtin-ensure'
import { preservedSwapCtx } from '../../lib/builtin-ctx'
import { builtinModelMatches } from '../../lib/builtin-model-identity'
import {
  backendNote, effectiveStrengths, entriesFor, hasPersonaProfile, jobProgressText, jobShare, sameEntries,
  clampStrength, steeringPersona, strengthWarning, warningText, type BackendKind,
} from '../../lib/neuron'
import { editingKey, useNeuronStore } from '../../stores/neuronStore'
import { useModelStore } from '../../stores/modelStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { BuiltinEngineTuning } from '../../types/settings'

const APPLY_DELAY_MS = 700

const NO_CHAT_MODEL = 'There is no chat model for LU Engine yet. Download one to start. An embedding model (the one Document Chat uses) cannot be tweaked.'

/** Which program answers the chat's model right now. */
function chatBackend(activeModel: string | null, appMode: string | undefined): BackendKind {
  if (appMode === 'cloud') return 'cloud'
  if (!activeModel) return 'none'
  const provider = getProviderIdFromModel(activeModel)
  if (provider === 'ollama') return 'ollama'
  if (provider === 'openai' && isManagedBuiltinSlot()) return 'lu-engine'
  if (String(provider).includes('lmstudio')) return 'lmstudio'
  return 'other'
}

/** The tuning a restart uses: the user's, with the context the engine holds
 *  kept the way the chat's own restarts keep it (lib/builtin-ctx). */
async function restartTuning(model: BundledModel | undefined): Promise<BuiltinEngineTuning | undefined> {
  const tuning = useSettingsStore.getState().settings.builtinEngine
  try {
    const status = await bundledEngineStatus()
    const keep = preservedSwapCtx({
      tuningCtx: tuning?.ctx,
      tuningChosen: tuning?.ctxChosen,
      currentCtx: status?.ctxRequested ?? status?.ctx,
      ctxTrain: model?.ctx_train,
    })
    return keep ? { ...(tuning ?? {}), ctx: keep } as BuiltinEngineTuning : tuning
  } catch {
    return tuning
  }
}

export function NeuronView() {
  const activeModel = useModelStore((s) => s.activeModel)
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const activePersonaId = useSettingsStore((s) => s.activePersonaId)
  const personas = useSettingsStore((s) => s.personas)
  const personasOn = useSettingsStore((s) => s.settings.personasEnabled !== false)
  const conv = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId))
  const steering = steeringPersona(conv, personas, activePersonaId, personasOn)
  const personaId = steering.id ?? undefined
  const persona = personas.find((p) => p.id === personaId)
  const { profiles, scopeByModel, setStrength, setProfile, removeProfile, removeSlider, setScope } = useNeuronStore()

  const [models, setModels] = useState<BundledModel[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [modelPath, setModelPath] = useState<string>('')
  // The info is kept with the model it was read for: after a switch the old
  // model's sliders must not reach the new one while its info is on the way.
  const [loadedInfo, setLoadedInfo] = useState<{ path: string; info: NeuronInfo } | null>(null)
  const [presets, setPresets] = useState<NeuronPreset[]>([])
  const [job, setJob] = useState<NeuronJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'applied'>('idle')
  const [lastApplied, setLastApplied] = useState<string>('')

  const backend = chatBackend(activeModel, appMode)
  const model = models.find((m) => m.path === modelPath)
  const info = loadedInfo?.path === modelPath ? loadedInfo.info : null
  const pathRef = useRef(modelPath)
  pathRef.current = modelPath

  // Models and presets once; the loaded model (or the chat's) preselected.
  useEffect(() => {
    void neuronPresets().then(setPresets).catch(() => setPresets([]))
    void listBundledModels().then((all) => {
      // Chat models only: an embedding model (Document Chat's) has no chat
      // turn to steer, and the vector tool aborts on it.
      const list = all.filter((m) => !isEmbeddingGgufName(m.name))
      setModels(list)
      const loaded = list.find((m) => m.loaded)
      const chat = list.find((m) => activeModel && builtinModelMatches(m.path, activeModel) && activeModel.includes(m.name))
      setModelPath((cur) => cur || (chat ?? loaded ?? list[0])?.path || '')
    }).catch(() => setModels([])).finally(() => setModelsLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshInfo = useCallback(async (path: string) => {
    if (!path) return
    try {
      const read = await neuronInfo(path)
      if (path !== pathRef.current) return
      setLoadedInfo({ path, info: read })
      setError(null)
    } catch (e) {
      if (path !== pathRef.current) return
      setLoadedInfo(null)
      setError(String(e))
    }
  }, [])

  useEffect(() => { void refreshInfo(modelPath) }, [modelPath, refreshInfo])

  // Job polling while something runs (and once on mount, to pick up a job
  // that was started before the view opened).
  const pollRef = useRef<number | null>(null)
  const poll = useCallback(async () => {
    try {
      const j = await neuronStatus()
      setJob(j)
      if (j.status === 'running') {
        pollRef.current = window.setTimeout(() => void poll(), 1000)
      } else if (j.status === 'done') {
        await refreshInfo(j.modelPath || modelPath)
      }
    } catch { /* backend gone: nothing to show */ }
  }, [modelPath, refreshInfo])
  useEffect(() => {
    void poll()
    return () => { if (pollRef.current) window.clearTimeout(pollRef.current) }
  }, [poll])

  const modelKey = info?.modelKey ?? ''
  const scope = (personaId && scopeByModel[modelKey]) || 'model'
  const editKey = editingKey(modelKey, personaId, scope)
  const strengths = useMemo(() => {
    if (!modelKey) return {}
    return scope === 'persona' ? (profiles[editKey] ?? effectiveStrengths(profiles, modelKey, null)) : (profiles[editKey] ?? {})
  }, [profiles, editKey, modelKey, scope])
  const vectors = useMemo(() => info?.vectors ?? [], [info])
  const available = useMemo(() => new Set(vectors.map((v) => v.id)), [vectors])
  const effective = useMemo(() => modelKey ? effectiveStrengths(profiles, modelKey, personaId) : {}, [profiles, modelKey, personaId])
  const entries = useMemo(() => entriesFor(effective, available), [effective, available])
  const warning = warningText(strengthWarning(entries))
  const running = job?.status === 'running'

  // Apply after the sliders rest for a moment. A restart takes seconds, so
  // dragging must not cause one per pixel.
  useEffect(() => {
    if (!modelPath || !info) return
    const sig = `${modelPath}|${JSON.stringify(entries)}`
    if (sig === lastApplied) return
    const t = window.setTimeout(() => {
      void (async () => {
        setApplyState('applying')
        try {
          await neuronApply(modelPath, entries, await restartTuning(model))
          setLastApplied(sig)
          setApplyState('applied')
          await refreshInfo(modelPath)
        } catch (e) {
          setError(String(e))
          setApplyState('idle')
        }
      })()
    }, lastApplied === '' ? 0 : APPLY_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [entries, modelPath, info, lastApplied, model, refreshInfo])

  const startJob = async (start: () => Promise<unknown>) => {
    setError(null)
    try {
      await start()
      await poll()
    } catch (e) {
      setError(String(e))
    }
  }

  // A persona without its own profile shows the model's; its first move
  // starts from what is shown, so the other sliders keep their place (T1:
  // they fell to 0 when the saved scope was already "persona").
  const move = (id: string, value: number) => {
    if (editKey in profiles) setStrength(editKey, id, value)
    else setProfile(editKey, { ...strengths, [id]: clampStrength(value) })
  }

  const reset = () => {
    if (!modelKey) return
    if (scope === 'persona') removeProfile(editKey)
    else setProfile(editKey, {})
  }

  if (modelsLoaded && models.length === 0) {
    return (
      <Shell>
        {backend !== 'lu-engine' && backend !== 'none' && <Hinweis className="mb-3">{backendNote(backend)}</Hinweis>}
        <Hinweis><span data-testid="neuron-no-chat-model">{NO_CHAT_MODEL}</span></Hinweis>
      </Shell>
    )
  }

  return (
    <Shell>
      {backend !== 'lu-engine' && <Hinweis className="mb-3">{backendNote(backend)}</Hinweis>}
      {error && <Hinweis ton="fehler" className="mb-3" onDismiss={() => setError(null)}>{error}</Hinweis>}

      <div className="flex flex-wrap items-center gap-2 mb-1">
        <label className="t-body text-gray-600 dark:text-gray-300" htmlFor="neuron-model">Model</label>
        <select
          id="neuron-model"
          data-testid="neuron-model"
          className="t-body rounded-md bg-gray-100 dark:bg-white/[0.06] px-2 py-1 text-gray-900 dark:text-white max-w-full"
          value={modelPath}
          onChange={(e) => { setModelPath(e.target.value); setLastApplied('') }}
        >
          {models.map((m) => <option key={m.path} value={m.path}>{m.name}{m.loaded ? ' (loaded)' : ''}</option>)}
        </select>
        {applyState === 'applying' && <span className={`t-micro ${HINWEIS_TEXT.ruhig} inline-flex items-center gap-1`}><Loader2 size={12} className="animate-spin" /> Restarting the engine with your sliders…</span>}
        {applyState === 'applied' && <span className={`t-micro ${HINWEIS_TEXT.ruhig}`} data-testid="neuron-applied">{entries.length ? `Active in chat: ${entries.length} slider${entries.length > 1 ? 's' : ''}` : 'Off: the model runs unchanged'}</span>}
      </div>
      {info && (
        <p className={`t-micro ${HINWEIS_TEXT.ruhig} mb-3`}>
          {info.facts.arch} · {info.facts.nLayer} layers · sliders act on layers {info.band[0]}–{info.band[1]}
        </p>
      )}

      {persona && modelKey && (
        <div className="flex flex-wrap items-center gap-1 mb-4 t-body" role="radiogroup" aria-label="Save sliders for">
          <span className="text-gray-600 dark:text-gray-300 mr-1">Save for</span>
          <ScopeButton on={scope === 'model'} onClick={() => setScope(modelKey, 'model')}>This model</ScopeButton>
          <ScopeButton on={scope === 'persona'} onClick={() => { setScope(modelKey, 'persona'); if (!hasPersonaProfile(profiles, modelKey, persona.id)) setProfile(editingKey(modelKey, persona.id, 'persona'), { ...(profiles[modelKey] ?? {}) }) }}>
            This model with “{persona.name}”
          </ScopeButton>
        </div>
      )}

      {steering.group && (
        <Hinweis className="mb-3"><span data-testid="neuron-group-note">This chat is a group chat: the model&apos;s sliders apply to every speaker. Sliders saved for one persona apply in its own chats (per speaker: later version).</span></Hinweis>
      )}

      {job && job.status !== 'idle' && <JobPanel job={job} onStop={() => void neuronCancel().then(poll)} onDismiss={() => void neuronDismiss().then(poll)} />}

      <Section title="Sliders">
        {info && !info.generator && (
          <Hinweis className="mb-2">This install is missing its vector tool, so ready-made and own sliders cannot be computed. Reinstall LU to bring it back. Feature sliders still work where the model has one.</Hinweis>
        )}
        <div className="space-y-2" data-testid="neuron-presets">
          {presets.map((p) => {
            const v = vectors.find((x) => x.id === p.id)
            return (
              <SliderRow
                key={p.id}
                id={p.id}
                left={p.left}
                right={p.right}
                value={strengths[p.id] ?? 0}
                computed={!!v}
                disabled={running || !modelPath || (!v && !info?.generator)}
                onCompute={() => void startJob(() => neuronBuildPreset(modelPath, p.id))}
                onChange={(x) => move(p.id, x)}
              />
            )
          })}
        </div>
      </Section>

      <Section title="Your own sliders">
        <div className="space-y-2" data-testid="neuron-own">
          {vectors.filter((v) => v.kind === 'own').map((v) => (
            <SliderRow
              key={v.id}
              id={v.id}
              left={v.left}
              right={v.right}
              value={strengths[v.id] ?? 0}
              computed
              disabled={running}
              onChange={(x) => move(v.id, x)}
              onDelete={() => void neuronDelete(modelPath, v.id).then(() => { removeSlider(modelKey, v.id); return refreshInfo(modelPath) })}
            />
          ))}
        </div>
        <OwnSliderForm disabled={running || !info?.generator || !modelPath} onCompute={(name, more, less) => void startJob(() => neuronBuildOwn(modelPath, name, more, less))} />
      </Section>

      {info?.sae && (
        <Section title="Features">
          <FeaturePanel
            info={info}
            modelPath={modelPath}
            vectors={vectors.filter((v) => v.kind === 'feature')}
            strengths={strengths}
            disabled={running}
            onDownload={() => void startJob(() => neuronSaeDownload(modelPath))}
            onAdd={(hit) => void startJob(() => neuronFeatureAdd(modelPath, hit.feature, hit.label))}
            onChange={(id, x) => move(id, x)}
            onDelete={(id) => void neuronDelete(modelPath, id).then(() => { removeSlider(modelKey, id); return refreshInfo(modelPath) })}
            onError={setError}
          />
        </Section>
      )}

      {warning && <Hinweis className="mb-3" >{warning}</Hinweis>}

      <div className="flex items-center gap-2 mb-6">
        <button
          type="button"
          data-testid="neuron-reset"
          onClick={reset}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md t-body bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-gray-800 dark:text-gray-100"
        >
          <RotateCcw size={ICON_SM} /> Reset
        </button>
        <span className={`t-micro ${HINWEIS_TEXT.ruhig}`}>All sliders to 0: the model answers exactly as without the tweaker.</span>
      </div>

      <Section title="Before and after">
        <ComparePanel modelPath={modelPath} entries={entries} disabled={running || !modelPath} model={model} onError={setError} />
      </Section>

      <Section title="What this can and cannot do">
        <ul className={`t-micro ${HINWEIS_TEXT.ruhig} list-disc pl-4 space-y-1`}>
          <li>Works with models in LU Engine (llama.cpp control vectors). Ollama, LM Studio and cloud models take no control vectors, so the sliders cannot reach them.</li>
          <li>Each slider is computed for this model the first time: LU reads short example pairs through the model and measures how far it can push before answers break. Seconds for small models, a few minutes for large ones. The chat pauses meanwhile.</li>
          <li>±1 is just under where the measured answer started to break. Strong settings or many sliders at once can still make text repeat or wander.</li>
          <li>A change restarts the engine with the new sliders (a few seconds). The settings stay for this model across restarts of LU.</li>
          <li>Features exist only for models with an official sparse autoencoder: Gemma 3 270M IT and 1B IT (Gemma Scope 2, CC-BY-4.0). Their names come from the words each feature pushes, and some are hard to name.</li>
        </ul>
      </Section>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin" data-testid="neuron-view">
      <div className="max-w-2xl mx-auto px-4 py-4">
        <div className="flex items-center gap-2 mb-1">
          <Sliders size={16} className="text-gray-500" />
          <h1 className="t-title text-gray-900 dark:text-white">Neuron tweaker</h1>
        </div>
        <p className={`t-body ${HINWEIS_TEXT.ruhig} mb-4`}>Turn your local model’s traits up or down, like an equalizer. It acts inside the model, not in the prompt.</p>
        {children}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="t-body font-medium text-gray-900 dark:text-white mb-2">{title}</h2>
      {children}
    </section>
  )
}

function ScopeButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`px-2 py-0.5 rounded-md ${on ? 'bg-lu-accent/20 text-gray-900 dark:text-white' : 'bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300'}`}
    >
      {children}
    </button>
  )
}

interface SliderRowProps {
  id: string
  left: string
  right: string
  value: number
  computed: boolean
  disabled?: boolean
  onChange: (v: number) => void
  onCompute?: () => void
  onDelete?: () => void
}

function SliderRow({ id, left, right, value, computed, disabled, onChange, onCompute, onDelete }: SliderRowProps) {
  return (
    <div className="grid grid-cols-[7rem_1fr_7rem_3rem_auto] items-center gap-2" data-testid={`neuron-slider-${id}`}>
      <span className="t-body text-right text-gray-700 dark:text-gray-200 truncate" title={left}>{left}</span>
      {computed ? (
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={value}
          disabled={disabled}
          aria-label={`${left} to ${right}`}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => onChange(0)}
          className="w-full accent-lu-accent"
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={onCompute}
          data-testid={`neuron-compute-${id}`}
          className="t-micro rounded-md px-2 py-1 bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-gray-700 dark:text-gray-200 disabled:opacity-50"
        >
          Compute for this model
        </button>
      )}
      <span className="t-body text-gray-700 dark:text-gray-200 truncate" title={right}>{right}</span>
      <span className={`t-micro tabular-nums ${HINWEIS_TEXT.ruhig}`}>{computed ? (value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2)) : ''}</span>
      {onDelete ? (
        <button type="button" onClick={onDelete} aria-label={`Delete ${right}`} className="p-1 text-gray-400 hover:text-red-500"><Trash2 size={ICON_SM} /></button>
      ) : <span />}
    </div>
  )
}

function JobPanel({ job, onStop, onDismiss }: { job: NeuronJob; onStop: () => void; onDismiss: () => void }) {
  const share = jobShare(job)
  if (job.status === 'running') {
    return (
      <div className="space-y-1.5 mb-5" data-testid="neuron-job">
        <p className="flex items-center gap-1.5 t-body text-gray-700 dark:text-gray-200">
          <Loader2 size={ICON_SM} className="animate-spin" /> {job.title}: {job.phaseLabel || 'starting…'}
        </p>
        <div className="h-1 rounded-full bg-gray-200 dark:bg-white/[0.08] overflow-hidden">
          <div className="h-full rounded-full bg-lu-accent transition-[width]" style={{ width: share == null ? '0%' : `${Math.round(share * 100)}%` }} />
        </div>
        <p className={`t-micro font-mono ${HINWEIS_TEXT.ruhig}`} data-testid="neuron-job-progress">{jobProgressText(job)}</p>
        {job.logs.length > 0 && <p className={`t-micro ${HINWEIS_TEXT.ruhig} truncate`}>{job.logs[job.logs.length - 1]}</p>}
        <button type="button" onClick={onStop} className="t-micro text-red-600 dark:text-red-400 hover:underline">Stop</button>
      </div>
    )
  }
  return (
    <div className="mb-5" data-testid="neuron-job-ended">
      {job.status === 'done' && <Hinweis onDismiss={onDismiss}>{job.title}: done{job.elapsedSecs ? ` in ${job.elapsedSecs} s` : ''}.{job.logs.find((l) => l.includes('full strength')) ? ` ${job.logs.find((l) => l.includes('full strength'))?.trim()}.` : ''}</Hinweis>}
      {job.status === 'failed' && <Hinweis ton="fehler" onDismiss={onDismiss}>{job.title} failed: {job.error}</Hinweis>}
      {job.status === 'cancelled' && <Hinweis onDismiss={onDismiss}>{job.title}: stopped.</Hinweis>}
    </div>
  )
}

function OwnSliderForm({ disabled, onCompute }: { disabled: boolean; onCompute: (name: string, more: string[], less: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [more, setMore] = useState('')
  const [less, setLess] = useState('')
  const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} data-testid="neuron-own-new" className="mt-2 t-body text-lu-accent hover:underline disabled:opacity-50">
        + New slider from examples
      </button>
    )
  }
  const ok = name.trim() && lines(more).length > 0 && lines(less).length > 0
  return (
    <div className="mt-3 space-y-2" data-testid="neuron-own-form">
      <input
        className="w-full t-body rounded-md bg-gray-100 dark:bg-white/[0.06] px-2 py-1 text-gray-900 dark:text-white"
        placeholder="Name, e.g. Pirate"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        data-testid="neuron-own-name"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="t-micro text-gray-600 dark:text-gray-300">More like this (one per line)
          <textarea rows={4} className="mt-1 w-full t-body rounded-md bg-gray-100 dark:bg-white/[0.06] px-2 py-1 text-gray-900 dark:text-white" placeholder={'Talk like a pirate.\nSay arr and matey.'} value={more} onChange={(e) => setMore(e.target.value)} data-testid="neuron-own-more" />
        </label>
        <label className="t-micro text-gray-600 dark:text-gray-300">Less like this (one per line)
          <textarea rows={4} className="mt-1 w-full t-body rounded-md bg-gray-100 dark:bg-white/[0.06] px-2 py-1 text-gray-900 dark:text-white" placeholder={'Talk in plain modern English.'} value={less} onChange={(e) => setLess(e.target.value)} data-testid="neuron-own-less" />
        </label>
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={disabled || !ok} onClick={() => { onCompute(name.trim(), lines(more), lines(less)); setOpen(false); setName(''); setMore(''); setLess('') }} data-testid="neuron-own-compute" className="px-3 py-1.5 rounded-md t-body bg-lu-accent text-white disabled:opacity-50">
          Compute slider
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-md t-body text-gray-600 dark:text-gray-300">Cancel</button>
      </div>
    </div>
  )
}

interface FeaturePanelProps {
  info: NeuronInfo
  modelPath: string
  vectors: NeuronVector[]
  strengths: Record<string, number>
  disabled: boolean
  onDownload: () => void
  onAdd: (hit: FeatureHit) => void
  onChange: (id: string, v: number) => void
  onDelete: (id: string) => void
  onError: (e: string) => void
}

function FeaturePanel({ info, modelPath, vectors, strengths, disabled, onDownload, onAdd, onChange, onDelete, onError }: FeaturePanelProps) {
  const sae = info.sae!
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FeatureHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      setHits((await neuronSaeSearch(modelPath, query)).hits)
    } catch (e) {
      onError(String(e))
    } finally {
      setSearching(false)
    }
  }
  return (
    <div data-testid="neuron-features">
      <p className={`t-micro ${HINWEIS_TEXT.ruhig} mb-2`}>
        {sae.title}. License {sae.license}.{' '}
        <button type="button" className="underline" onClick={() => void openExternal(sae.source)}>Source</button>
        {!sae.instruct && ' This file does not look like the instruction-tuned model the features were trained on; they may act weaker.'}
      </p>
      {!sae.downloaded ? (
        <button type="button" disabled={disabled} onClick={onDownload} data-testid="neuron-sae-download" className="px-3 py-1.5 rounded-md t-body bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-gray-800 dark:text-gray-100 disabled:opacity-50">
          Download feature data ({Math.round(sae.bytes / 1e6)} MB)
        </button>
      ) : (
        <>
          <form className="flex gap-2 mb-2" onSubmit={(e) => { e.preventDefault(); void search() }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search features, e.g. location, love, #1234" data-testid="neuron-feature-query" className="flex-1 t-body rounded-md bg-gray-100 dark:bg-white/[0.06] px-2 py-1 text-gray-900 dark:text-white" />
            <button type="submit" disabled={searching} data-testid="neuron-feature-search" className="px-2 rounded-md bg-gray-100 dark:bg-white/[0.06] text-gray-700 dark:text-gray-200">
              {searching ? <Loader2 size={ICON_SM} className="animate-spin" /> : <Search size={ICON_SM} />}
            </button>
          </form>
          {hits && hits.length === 0 && <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>No feature pushes that word. Try another word or a feature number (#1234).</p>}
          {hits && hits.length > 0 && (
            <ul className="mb-3 max-h-56 overflow-y-auto scrollbar-thin space-y-1" data-testid="neuron-feature-hits">
              {hits.map((h) => (
                <li key={h.feature} className="flex items-center gap-2 t-micro">
                  <span className="tabular-nums text-gray-500 w-12">#{h.feature}</span>
                  <span className="flex-1 truncate text-gray-700 dark:text-gray-200" title={h.label}>{h.label}</span>
                  <button type="button" disabled={disabled || vectors.some((v) => v.feature === h.feature)} onClick={() => onAdd(h)} className="text-lu-accent hover:underline disabled:opacity-40">Add</button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-2">
            {vectors.map((v) => (
              <SliderRow key={v.id} id={v.id} left="Less" right={v.name} value={strengths[v.id] ?? 0} computed disabled={disabled} onChange={(x) => onChange(v.id, x)} onDelete={() => onDelete(v.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ComparePanel({ modelPath, entries, disabled, model, onError }: { modelPath: string; entries: ReturnType<typeof entriesFor>; disabled: boolean; model: BundledModel | undefined; onError: (e: string) => void }) {
  const [question, setQuestion] = useState('Write two sentences about rain.')
  const [seed, setSeed] = useState(42)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<(CompareResult & { entries: typeof entries }) | null>(null)
  const run = async () => {
    setBusy(true)
    try {
      const r = await neuronCompare(modelPath, question, seed, entries, await restartTuning(model))
      setResult({ ...r, entries })
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const stale = result && !sameEntries(result.entries, entries)
  return (
    <div data-testid="neuron-compare">
      <div className="flex flex-wrap gap-2 mb-2">
        <input value={question} onChange={(e) => setQuestion(e.target.value)} data-testid="neuron-compare-question" className="flex-1 min-w-[12rem] t-body rounded-md bg-gray-100 dark:bg-white/[0.06] px-2 py-1 text-gray-900 dark:text-white" />
        <label className={`t-micro ${HINWEIS_TEXT.ruhig} flex items-center gap-1`}>Seed
          <input type="number" value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} className="w-20 t-body rounded-md bg-gray-100 dark:bg-white/[0.06] px-2 py-1 text-gray-900 dark:text-white" />
        </label>
        <button type="button" disabled={disabled || busy || !question.trim()} onClick={() => void run()} data-testid="neuron-compare-run" className="px-3 py-1.5 rounded-md t-body bg-lu-accent text-white disabled:opacity-50 inline-flex items-center gap-1.5">
          {busy && <Loader2 size={ICON_SM} className="animate-spin" />} Compare
        </button>
      </div>
      <p className={`t-micro ${HINWEIS_TEXT.ruhig} mb-2`}>Same question, same seed, temperature 0: once with the sliders off, once on. The engine restarts twice.</p>
      {result && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="neuron-compare-result">
            <div>
              <p className="t-micro text-gray-500 mb-1">Before (sliders off)</p>
              <p className="t-body text-gray-800 dark:text-gray-100 whitespace-pre-wrap" data-testid="neuron-compare-before">{result.before}</p>
            </div>
            <div>
              <p className="t-micro text-gray-500 mb-1">After ({result.entries.map((e) => `${e.id} ${e.strength > 0 ? '+' : ''}${e.strength}`).join(', ') || 'all at 0'})</p>
              <p className="t-body text-gray-800 dark:text-gray-100 whitespace-pre-wrap" data-testid="neuron-compare-after">{result.after}</p>
            </div>
          </div>
          <p className={`t-micro ${HINWEIS_TEXT.ruhig} mt-1`} data-testid="neuron-compare-same">
            {result.same ? 'Identical answers.' : 'The answers differ.'}{stale ? ' The sliders changed since; compare again.' : ''}
          </p>
        </>
      )}
    </div>
  )
}
