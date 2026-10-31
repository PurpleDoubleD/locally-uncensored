import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleHelp, Download, FilePlus, FlaskConical, Hash, Loader2, RotateCcw, Sliders, Sparkles } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { HOWTO } from '../../lib/howto'
import { ICON_SM } from '../ui/icon-size'
import { addGgufFile, listBundledModels, bundledEngineStatus, isEmbeddingGgufName, type BundledModel } from '../../api/engine'
import * as neuronApi from '../../api/neuron'
import {
  neuronApply, neuronBuildOwn, neuronBuildPreset, neuronCancel, neuronDelete, neuronDismiss,
  neuronFeatureAdd, neuronInfo, neuronPresets, neuronSaeDownload, neuronStatus,
  type NeuronInfo, type NeuronJob, type NeuronPreset,
} from '../../api/neuron'
import { getProviderIdFromModel } from '../../api/providers/model-name'
import { isManagedBuiltinSlot } from '../../api/builtin-ensure'
import { preservedSwapCtx } from '../../lib/builtin-ctx'
import { builtinModelMatches } from '../../lib/builtin-model-identity'
import {
  backendNote, effectiveStrengths, entriesFor, hasPersonaProfile,
  clampStrength, steeringPersona, strengthWarning, tweakedModelNote, warningText, type BackendKind, type Strengths,
} from '../../lib/neuron'
import { featureVectorId, neuronVectorId, recipeOwnId, type Recipe, type RecipeEntry } from '../../lib/neuron-recipe'
import { editingKey, useNeuronStore } from '../../stores/neuronStore'
import { useModelStore } from '../../stores/modelStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import type { BuiltinEngineTuning } from '../../types/settings'
import { JobPanel, ScopeButton, SliderRow, StepCard, TweakedNote, WayIntro, WayTabs, signedValue } from './parts'
import { ComparePanel, CoordinatesPanel, FeaturePanel, OwnSliderForm, SharePanel, entryState, type NeuronInfoPlus } from './panels'
import { NeuronIntroHost } from './NeuronIntro'
import { useNeuronIntroRequest } from '../../stores/neuronIntroStore'

const APPLY_DELAY_MS = 700

const NO_CHAT_MODEL = 'The tweaker works on chat models the LU Engine runs. Download one, or use a GGUF file you already have. An embedding model (the one Document Chat uses) cannot be tweaked.'
const GGUF_STEPS = HOWTO['gguf-file'].films[0].steps
/** Why a model the user already has in Ollama or LM Studio is not offered. */
const OTHER_APPS = 'Models in Ollama or LM Studio do not show up here: those programs take no control vectors, so the sliders cannot reach them.'

type Way = 'ready' | 'own' | 'features' | 'coords'

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

/** The engine piece for single neurons (AN-P11-N2.md), when this build has
 *  it. Read through the module, so the page needs no change once it lands. */
function mlpAdd(): ((modelPath: string, layer: number, neuron: number) => Promise<unknown>) | null {
  try {
    const fn = (neuronApi as Record<string, unknown>).neuronMlpAdd
    return typeof fn === 'function' ? fn as (p: string, l: number, n: number) => Promise<unknown> : null
  } catch {
    return null
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
  const [way, setWay] = useState<Way>('ready')
  const [compared, setCompared] = useState(false)
  // Jobs a recipe asked for, run one after the other.
  const [queue, setQueue] = useState<Array<() => Promise<unknown>>>([])
  const [undo, setUndo] = useState<{ key: string; prev: Strengths | undefined } | null>(null)

  const backend = chatBackend(activeModel, appMode)
  const model = models.find((m) => m.path === modelPath)
  const info = loadedInfo?.path === modelPath ? loadedInfo.info as NeuronInfoPlus : null
  const pathRef = useRef(modelPath)
  pathRef.current = modelPath

  // Presets once; the models once and again after a GGUF file was added
  // from the empty state. The loaded model (or the chat's) preselected.
  const [modelsSeq, setModelsSeq] = useState(0)
  useEffect(() => {
    void neuronPresets().then(setPresets).catch(() => setPresets([]))
  }, [])
  useEffect(() => {
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
  }, [modelsSeq])

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

  const startJob = useCallback(async (start: () => Promise<unknown>) => {
    setError(null)
    try {
      await start()
      await poll()
    } catch (e) {
      setError(String(e))
    }
  }, [poll])

  // A recipe's jobs, one at a time: the next starts when nothing runs.
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    if (running || starting || queue.length === 0) return
    const [next, ...rest] = queue
    setStarting(true)
    setQueue(rest)
    void startJob(next).finally(() => setStarting(false))
  }, [running, starting, queue, startJob])

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

  const deleteVector = (id: string) => void neuronDelete(modelPath, id).then(() => { removeSlider(modelKey, id); return refreshInfo(modelPath) })

  const ids = useMemo(() => ({
    feature: (n: number) => featureVectorId(info?.sae?.id ?? '', n),
    neuron: neuronVectorId,
    own: recipeOwnId,
  }), [info])
  const mlp = info?.mlpNeurons ? mlpAdd() : null
  const states = useCallback((e: RecipeEntry) => {
    if (!info) return { state: 'blocked' as const, why: 'The model is still loading.' }
    return entryState(e, { ...info, mlpNeurons: !!mlp }, available, ids)
  }, [info, mlp, available, ids])

  /** A recipe replaces the sliders (one Undo brings them back); what is not
   *  computed for this model yet is queued and prepared one by one. */
  const applyRecipe = (recipe: Recipe) => {
    if (!modelKey || !info) return
    setUndo({ key: editKey, prev: profiles[editKey] })
    const next: Strengths = {}
    const jobs: Array<() => Promise<unknown>> = []
    for (const e of recipe.entries) {
      const st = states(e)
      if (st.state === 'blocked') continue
      if (e.kind === 'preset') {
        next[e.id] = clampStrength(e.strength)
        if (st.state === 'prepare') jobs.push(() => neuronBuildPreset(modelPath, e.id))
      } else if (e.kind === 'feature') {
        next[ids.feature(e.feature)] = clampStrength(e.strength)
        if (st.state === 'prepare') jobs.push(() => neuronFeatureAdd(modelPath, e.feature))
      } else if (e.kind === 'own') {
        const id = recipeOwnId(e)
        next[id] = clampStrength(e.strength)
        if (st.state === 'prepare') jobs.push(() => neuronBuildOwn(modelPath, e.name, e.more, e.less, id))
      } else {
        next[neuronVectorId(e.layer, e.neuron)] = clampStrength(e.dose)
        if (st.state === 'prepare' && mlp) jobs.push(() => mlp(modelPath, e.layer, e.neuron))
      }
    }
    setProfile(editKey, next)
    setQueue(jobs)
  }

  const undoRecipe = () => {
    if (!undo) return
    if (undo.prev) setProfile(undo.key, undo.prev)
    else removeProfile(undo.key)
    setQueue([])
    setUndo(null)
  }

  // The mix as a recipe to share: what is on, by its kind.
  const share = useMemo(() => {
    const out: RecipeEntry[] = []
    const skipped: string[] = []
    for (const e of entries) {
      const v = vectors.find((x) => x.id === e.id)
      if (!v) continue
      const nm = /^n-L(\d+)-N(\d+)$/.exec(v.id)
      if (v.kind === 'preset') out.push({ kind: 'preset', id: v.id, strength: e.strength })
      else if (v.kind === 'feature' && v.feature != null) out.push({ kind: 'feature', feature: v.feature, strength: e.strength })
      else if (v.kind === 'own') {
        const clean = (ls: string[]) => ls.map((l) => l.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 40)
        const more = clean(v.more)
        const less = clean(v.less)
        if (more.length && less.length) out.push({ kind: 'own', name: v.name.slice(0, 40), more, less, strength: e.strength })
        else skipped.push(v.name)
      } else if (nm) out.push({ kind: 'neuron', layer: Number(nm[1]), neuron: Number(nm[2]), dose: e.strength })
      else skipped.push(v.name)
    }
    const recipe: Recipe = { model: info?.facts.name || model?.name || null, entries: out }
    return { recipe, skipped }
  }, [entries, vectors, info, model])

  const showIntro = useNeuronIntroRequest((s) => s.show)

  // A model changed before (fine-tune, merge, heretic …): say so before
  // computing, and offer its original in Discover (David, 31.10.2026).
  const tweak = info ? tweakedModelNote(info.facts) : null
  const original = info?.facts.original ?? null
  const getOriginal = () => {
    if (!original) return
    useModelStore.getState().setCategoryFilter('text')
    useUIStore.getState().openDiscoverFor('builtin', original, { original: true })
  }

  if (modelsLoaded && models.length === 0) {
    return (
      <>
        <NoModel
          onDownload={() => {
            useModelStore.getState().setCategoryFilter('text')
            useUIStore.getState().openDiscoverFor('builtin')
          }}
          onAddFile={async () => {
            try {
              if (await addGgufFile()) setModelsSeq((n) => n + 1)
            } catch (e) {
              setError(String(e))
            }
          }}
          onIntro={showIntro}
          error={error}
          onDismissError={() => setError(null)}
        />
        <NeuronIntroHost />
      </>
    )
  }

  const presetRows = presets.map((p) => ({ p, v: vectors.find((x) => x.id === p.id) }))
  const own = vectors.filter((v) => v.kind === 'own')
  const features = vectors.filter((v) => v.kind === 'feature')
  const neurons = vectors.filter((v) => /^n-L\d+-N\d+$/.test(v.id))
  const onCount = (pred: (id: string) => boolean) => entries.filter((e) => pred(e.id)).length
  const labelOf = (id: string) => {
    const v = vectors.find((x) => x.id === id)
    if (!v) return id
    if (v.kind === 'preset') return v.right
    return v.name
  }

  return (
    <Shell onIntro={showIntro}>
      <StepCard
        n={1}
        title="Pick a model"
        lead="Neurons works on chat models that run in the LU Engine."
        done={!!info && backend === 'lu-engine'}
        testId="neuron-step-model"
      >
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <label className="t-body font-medium text-gray-200" htmlFor="neuron-model">Model</label>
          <select
            id="neuron-model"
            data-testid="neuron-model"
            className="t-body rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.04] px-2.5 py-1.5 text-gray-900 dark:text-white min-w-0 w-full"
            value={modelPath}
            onChange={(e) => { setModelPath(e.target.value); setLastApplied(''); setCompared(false) }}
          >
            {models.map((m) => <option key={m.path} value={m.path}>{m.name}{m.loaded ? ' (loaded)' : ''}</option>)}
          </select>
          <span />
          <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>
            {info ? `${info.facts.arch} · ${info.facts.nLayer} layers · sliders act on layers ${info.band[0]}–${info.band[1]}` : 'Reading the model…'}
          </p>
        </div>
        {backend !== 'lu-engine' && <Hinweis className="mt-3">{backendNote(backend)}</Hinweis>}
        {steering.group && (
          <Hinweis className="mt-3"><span data-testid="neuron-group-note">This chat is a group chat: the model&apos;s sliders apply to every speaker. Sliders saved for one persona apply in its own chats (per speaker: later version).</span></Hinweis>
        )}
      </StepCard>

      <StepCard
        n={2}
        title="Choose your sliders"
        lead="Pick a way to change the model. Everything you turn on is listed at the bottom of this step."
        done={entries.length > 0}
        testId="neuron-step-sliders"
      >
        {error && <Hinweis ton="fehler" className="mb-3" onDismiss={() => setError(null)}>{error}</Hinweis>}
        {tweak && <TweakedNote title={tweak.title} text={tweak.text} original={tweak.original} onGetOriginal={getOriginal} />}
        {job && job.status !== 'idle' && <JobPanel job={job} onStop={() => { setQueue([]); void neuronCancel().then(poll) }} onDismiss={() => void neuronDismiss().then(poll)} onGetOriginal={getOriginal} original={original} />}
        {queue.length > 0 && <p className={`t-micro ${HINWEIS_TEXT.ruhig} mb-3`} data-testid="neuron-queue">{queue.length} more to prepare from the recipe, one after the other.</p>}
        {info && !info.generator && (
          <Hinweis className="mb-3">This install is missing its vector tool, so ready-made and own sliders cannot be computed. Reinstall LU to bring it back. Feature sliders still work where the model has one.</Hinweis>
        )}

        <WayTabs<Way>
          current={way}
          onPick={setWay}
          ways={[
            { id: 'ready', label: 'Ready-made', count: onCount((id) => presets.some((p) => p.id === id)) },
            { id: 'own', label: 'From examples', count: onCount((id) => id.startsWith('own-')) },
            { id: 'features', label: 'Features', count: onCount((id) => id.startsWith('f-')) },
            { id: 'coords', label: 'Coordinates', count: onCount((id) => id.startsWith('n-')) },
          ]}
        />

        <div role="tabpanel" id={`neuron-way-${way}`} aria-labelledby={`neuron-way-tab-${way}`}>
          {way === 'ready' && (
            <>
              <WayIntro icon={<Sliders size={16} />} title="Ready-made sliders">
                Five common traits. The first time, LU prepares each one for your model (it reads short example pairs and measures how far it can push).
              </WayIntro>
              <div className="grid grid-cols-1 gap-2" data-testid="neuron-presets">
                {presetRows.map(({ p, v }) => (
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
                ))}
              </div>
            </>
          )}

          {way === 'own' && (
            <>
              <WayIntro icon={<Sparkles size={16} />} title="Your own slider, from examples">
                Write a few lines in the style you want more of, and a few you want less of. LU turns the difference into a slider. This is how most people make new traits (control vectors).
              </WayIntro>
              <div className="space-y-2 mb-3" data-testid="neuron-own">
                {own.map((v) => (
                  <SliderRow key={v.id} id={v.id} left={v.left} right={v.right} value={strengths[v.id] ?? 0} computed disabled={running} onChange={(x) => move(v.id, x)} onDelete={() => deleteVector(v.id)} />
                ))}
              </div>
              <OwnSliderForm disabled={running || !info?.generator || !modelPath} onCompute={(name, more, less) => void startJob(() => neuronBuildOwn(modelPath, name, more, less))} />
            </>
          )}

          {way === 'features' && (
            <>
              <WayIntro icon={<FlaskConical size={16} />} title="Features: what the model knows">
                Some models come with a map of their inner concepts (a sparse autoencoder). Search a word, add the concept, and turn it up or down.
              </WayIntro>
              {info?.sae ? (
                <FeaturePanel
                  info={info}
                  modelPath={modelPath}
                  vectors={features}
                  strengths={strengths}
                  disabled={running}
                  onDownload={() => void startJob(() => neuronSaeDownload(modelPath))}
                  onAdd={(hit) => void startJob(() => neuronFeatureAdd(modelPath, hit.feature, hit.label))}
                  onChange={(id, x) => move(id, x)}
                  onDelete={deleteVector}
                  onError={setError}
                />
              ) : (
                <p className={`t-body ${HINWEIS_TEXT.ruhig}`} data-testid="neuron-features-none">
                  This model has no official feature map. Features exist for Gemma 3 270M IT and Gemma 3 1B IT (Gemma Scope 2 by Google DeepMind, CC-BY-4.0). Pick one of those in step 1, or use the other ways.
                </p>
              )}
            </>
          )}

          {way === 'coords' && (
            <>
              <WayIntro icon={<Hash size={16} />} title="Coordinates people share">
                A coordinate points at one spot inside a model, like “layer 14, neuron 8949, +1.0”. Paste what someone shared, check what it does, then use it.
              </WayIntro>
              {neurons.length > 0 && (
                <div className="space-y-2 mb-4">
                  {neurons.map((v) => (
                    <SliderRow key={v.id} id={v.id} left="Less" right={v.name} value={strengths[v.id] ?? 0} computed disabled={running} onChange={(x) => move(v.id, x)} onDelete={() => deleteVector(v.id)} />
                  ))}
                </div>
              )}
              {info ? (
                <CoordinatesPanel
                  presets={presets}
                  modelNames={[info.facts.name, model?.name]}
                  states={states}
                  onUse={applyRecipe}
                  disabled={running || !modelPath}
                />
              ) : <p className={`t-body ${HINWEIS_TEXT.ruhig}`}>Reading the model…</p>}
            </>
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-gray-200 dark:border-white/[0.06]" data-testid="neuron-mix">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="t-body font-medium text-gray-900 dark:text-white">On right now</p>
            <button type="button" data-testid="neuron-reset" onClick={reset} className="lu-control lu-control--outline">
              <RotateCcw size={ICON_SM} /> Reset all
            </button>
          </div>
          {entries.length === 0 ? (
            <p className={`t-body ${HINWEIS_TEXT.ruhig}`}>Nothing. The model answers exactly as without Neurons.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {entries.map((e) => (
                <li key={e.id} className="t-control inline-flex items-center gap-1.5 rounded-full border border-lu-accent/40 bg-lu-accent/[0.08] px-2.5 py-1 text-gray-900 dark:text-white">
                  {labelOf(e.id)} <span className="tabular-nums text-lu-accent">{signedValue(e.strength)}</span>
                </li>
              ))}
            </ul>
          )}
          {warning && <Hinweis className="mt-2">{warning}</Hinweis>}
          <p className={`t-micro ${HINWEIS_TEXT.ruhig} mt-2 flex items-center gap-1`} aria-live="polite">
            {applyState === 'applying' && <><Loader2 size={12} className="animate-spin" /> Restarting the engine with your sliders…</>}
            {applyState === 'applied' && <span data-testid="neuron-applied">{entries.length ? `Active in chat: ${entries.length} slider${entries.length > 1 ? 's' : ''}` : 'Off: the model runs unchanged'}</span>}
          </p>
        </div>
      </StepCard>

      <StepCard
        n={3}
        title="Try it: before and after"
        lead="Ask one question and see the answer without and with your sliders."
        done={compared}
        testId="neuron-step-compare"
      >
        <ComparePanel modelPath={modelPath} entries={entries} disabled={running || !modelPath} model={model} tuning={restartTuning} onError={setError} onDone={() => setCompared(true)} />
      </StepCard>

      <StepCard
        n={4}
        title="Keep and share"
        lead="Your sliders stay for this model, also after a restart of LU. Every new chat uses them."
        testId="neuron-step-share"
      >
        {persona && modelKey && (
          <div className="flex flex-wrap items-center gap-2 mb-4 t-body" role="radiogroup" aria-label="Save sliders for">
            <span className="text-gray-200 font-medium mr-1">Save for</span>
            <ScopeButton on={scope === 'model'} onClick={() => setScope(modelKey, 'model')}>This model</ScopeButton>
            <ScopeButton on={scope === 'persona'} onClick={() => { setScope(modelKey, 'persona'); if (!hasPersonaProfile(profiles, modelKey, persona.id)) setProfile(editingKey(modelKey, persona.id, 'persona'), { ...(profiles[modelKey] ?? {}) }) }}>
              This model with “{persona.name}”
            </ScopeButton>
          </div>
        )}
        <SharePanel recipe={share.recipe} skipped={share.skipped} onUndo={undo ? undoRecipe : undefined} />
      </StepCard>

      <details className="ml-10 mt-1 mb-8 rounded-xl border border-gray-200 dark:border-white/[0.08] px-4 py-3" data-testid="neuron-limits">
        <summary className="t-body font-medium text-gray-900 dark:text-white cursor-pointer">What this can and cannot do</summary>
        <ul className={`t-micro ${HINWEIS_TEXT.ruhig} list-disc pl-4 space-y-1 mt-2`}>
          <li>Works with models in LU Engine (llama.cpp control vectors). Ollama, LM Studio and cloud models take no control vectors, so the sliders cannot reach them.</li>
          <li>Each slider is computed for this model the first time: LU reads short example pairs through the model and measures how far it can push before answers break. Seconds for small models, a few minutes for large ones. The chat pauses meanwhile.</li>
          <li>±1 is just under where the measured answer started to break. Strong settings or many sliders at once can still make text repeat or wander.</li>
          <li>A change restarts the engine with the new sliders (a few seconds). The settings stay for this model across restarts of LU.</li>
          <li>Features exist only for models with an official sparse autoencoder: Gemma 3 270M IT and 1B IT (Gemma Scope 2, CC-BY-4.0). Their names come from the words each feature pushes, and some are hard to name.</li>
          <li>Small models (under 1B) show traits weakly; special ones like a pirate voice need a bigger model.</li>
        </ul>
      </details>
    </Shell>
  )
}

/** No LU Engine chat model yet: one centred state with the two ways to get
 *  one (David, 2026-10-30: the line used to sit at the top, "hingeklatscht").
 *  Download opens Discover with the LU Engine as the target whatever the chat
 *  model is, so the file lands where the tweaker can read it. */
function NoModel({ onDownload, onAddFile, onIntro, error, onDismissError }: {
  onDownload: () => void
  onAddFile: () => void
  onIntro: () => void
  error: string | null
  onDismissError: () => void
}) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin flex items-center justify-center px-6 py-8" data-testid="neuron-view">
      <div className="max-w-md flex flex-col items-center text-center gap-3" data-testid="neuron-empty">
        <Sliders size={28} className="text-gray-400 dark:text-gray-500" aria-hidden />
        <h1 className="t-title text-gray-900 dark:text-white">No chat model for the LU Engine yet</h1>
        <p className="t-body text-gray-300" data-testid="neuron-no-chat-model">{NO_CHAT_MODEL}</p>
        <p className={`t-body ${HINWEIS_TEXT.ruhig}`} data-testid="neuron-other-apps">{OTHER_APPS}</p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <button className="lu-tonal" onClick={onDownload} data-testid="neuron-get-model">
            <Download size={ICON_SM} /> Get a model for the LU Engine
          </button>
          <button className="lu-control" onClick={onIntro} data-testid="neuron-intro-open">
            <CircleHelp size={ICON_SM} /> How Neurons works
          </button>
        </div>
        {/* A file the user already has, in three steps (David, 30.10.2026).
            The lines are the how-to's, so Help and this state say the same. */}
        <div className="mt-3 w-full text-left rounded-lg border border-gray-200 dark:border-white/[0.06] px-4 py-3" data-testid="neuron-gguf-steps">
          <p className="t-body font-semibold text-gray-900 dark:text-white mb-1.5">Already have a GGUF file?</p>
          <ol className="t-body text-gray-300 space-y-1 list-decimal pl-5">
            {GGUF_STEPS.map((s) => <li key={s.from}>{s.text}</li>)}
          </ol>
          <button className="lu-control mt-2.5" onClick={onAddFile} data-testid="neuron-add-gguf" title="Use a GGUF file from your drive as a chat model on the LU Engine">
            <FilePlus size={ICON_SM} /> GGUF file
          </button>
        </div>
        {error && <Hinweis ton="fehler" className="mt-2 text-left" onDismiss={onDismissError}>{error}</Hinweis>}
      </div>
    </div>
  )
}

function Shell({ onIntro, children }: { onIntro: () => void; children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin" data-testid="neuron-view">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <header className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sliders size={18} className="text-lu-accent" aria-hidden />
              <h1 className="t-display text-gray-900 dark:text-white">Neurons</h1>
            </div>
            <p className={`t-body ${HINWEIS_TEXT.ruhig} mt-1 max-w-xl`}>Turn traits of your local model up or down, like an equalizer. It acts inside the model, not in your prompt. Four steps, top to bottom.</p>
          </div>
          <button type="button" className="lu-control lu-control--outline flex-none" onClick={onIntro} data-testid="neuron-intro-open">
            <CircleHelp size={ICON_SM} /> How it works
          </button>
        </header>
        {children}
      </div>
      <NeuronIntroHost />
    </div>
  )
}
