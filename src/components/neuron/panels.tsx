// The contents of the Neurons steps (N2, 3.0.9): the ways to make a slider
// (from examples, features, coordinates), before/after, and sharing. The
// work behind them is P11's (api/neuron, Rust); these only lay it out.

import { useMemo, useState } from 'react'
import { ArrowRight, Check, ClipboardCopy, Link2, Loader2, Search, Undo2 } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { ICON_SM } from '../ui/icon-size'
import { openExternal } from '../../api/backend'
import { neuronCompare, neuronSaeSearch, type CompareResult, type FeatureHit, type NeuronInfo, type NeuronVector } from '../../api/neuron'
import type { BundledModel } from '../../api/engine'
import { sameEntries, type entriesFor } from '../../lib/neuron'
import {
  coordsLine, entryCode, modelFit, parseRecipe, recipeText, recipeLink,
  type ModelFit, type Recipe, type RecipeEntry,
} from '../../lib/neuron-recipe'
import { SliderRow, signedValue } from './parts'
import type { BuiltinEngineTuning } from '../../types/settings'

const fieldBase = 't-body rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.04] px-2.5 py-1.5 text-gray-900 dark:text-white placeholder:text-gray-400'
const field = `w-full ${fieldBase}`

/** What the engine piece for single neurons adds to the model's info
 *  (AN-P11-N2.md). Absent until that piece is in. */
export type NeuronInfoPlus = NeuronInfo & { mlpNeurons?: boolean; nFf?: number }

// ── From examples ─────────────────────────────────────────────────────

export function OwnSliderForm({ disabled, onCompute }: { disabled: boolean; onCompute: (name: string, more: string[], less: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [more, setMore] = useState('')
  const [less, setLess] = useState('')
  const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} data-testid="neuron-own-new" className="lu-tonal">
        + New slider from examples
      </button>
    )
  }
  const ok = name.trim() && lines(more).length > 0 && lines(less).length > 0
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 dark:border-white/[0.08] p-3" data-testid="neuron-own-form">
      <label className="block t-body text-gray-200">
        <span className="block mb-1 font-medium">1. Name the trait</span>
        <input className={field} placeholder="e.g. Pirate" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="neuron-own-name" />
      </label>
      <div>
        <p className="t-body font-medium text-gray-200 mb-1">2. Write a few lines for each side</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block t-micro text-gray-300">More like this (one per line)
            <textarea rows={4} className={`${field} mt-1`} placeholder={'Talk like a pirate.\nSay arr and matey.'} value={more} onChange={(e) => setMore(e.target.value)} data-testid="neuron-own-more" />
          </label>
          <label className="block t-micro text-gray-300">Less like this (one per line)
            <textarea rows={4} className={`${field} mt-1`} placeholder={'Talk in plain modern English.'} value={less} onChange={(e) => setLess(e.target.value)} data-testid="neuron-own-less" />
          </label>
        </div>
        <p className={`t-micro ${HINWEIS_TEXT.ruhig} mt-1`}>Tip: keep both sides alike except for the trait. Three to ten lines each are plenty.</p>
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={disabled || !ok} onClick={() => { onCompute(name.trim(), lines(more), lines(less)); setOpen(false); setName(''); setMore(''); setLess('') }} data-testid="neuron-own-compute" className="lu-control lu-primary">
          3. Compute slider
        </button>
        <button type="button" onClick={() => setOpen(false)} className="lu-control">Cancel</button>
      </div>
    </div>
  )
}

// ── Features ──────────────────────────────────────────────────────────

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

export function FeaturePanel({ info, modelPath, vectors, strengths, disabled, onDownload, onAdd, onChange, onDelete, onError }: FeaturePanelProps) {
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
    <div data-testid="neuron-features" className="space-y-3">
      <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>
        {sae.title}. License {sae.license}.{' '}
        <button type="button" className="underline" onClick={() => void openExternal(sae.source)}>Source</button>
        {!sae.instruct && ' This file does not look like the instruction-tuned model the features were trained on; they may act weaker.'}
      </p>
      {!sae.downloaded ? (
        <button type="button" disabled={disabled} onClick={onDownload} data-testid="neuron-sae-download" className="lu-tonal">
          Download feature data ({Math.round(sae.bytes / 1e6)} MB)
        </button>
      ) : (
        <>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void search() }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a word, e.g. ocean, love, or #1234" aria-label="Search features" data-testid="neuron-feature-query" className={`${field} flex-1`} />
            <button type="submit" disabled={searching} data-testid="neuron-feature-search" className="lu-control lu-control--outline" aria-label="Search">
              {searching ? <Loader2 size={ICON_SM} className="animate-spin" /> : <Search size={ICON_SM} />}
            </button>
          </form>
          {hits && hits.length === 0 && <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>No feature pushes that word. Try another word or a feature number (#1234).</p>}
          {hits && hits.length > 0 && (
            <ul className="max-h-56 overflow-y-auto scrollbar-thin divide-y divide-gray-100 dark:divide-white/[0.05] rounded-lg border border-gray-200 dark:border-white/[0.06]" data-testid="neuron-feature-hits">
              {hits.map((h) => (
                <li key={h.feature} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 px-3 py-1.5 t-body">
                  <span className="tabular-nums t-mono text-gray-500">#{h.feature}</span>
                  <span className="truncate text-gray-200" title={h.label}>{h.label}</span>
                  <button type="button" disabled={disabled || vectors.some((v) => v.feature === h.feature)} onClick={() => onAdd(h)} className="lu-tonal">Add</button>
                </li>
              ))}
            </ul>
          )}
          {vectors.length > 0 && (
            <div className="space-y-2">
              {vectors.map((v) => (
                <SliderRow key={v.id} id={v.id} left="Less" right={v.name} value={strengths[v.id] ?? 0} computed disabled={disabled} onChange={(x) => onChange(v.id, x)} onDelete={() => onDelete(v.id)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Coordinates ───────────────────────────────────────────────────────

export type EntryState =
  | { state: 'ready' }
  | { state: 'prepare' }
  | { state: 'blocked'; why: string; later?: boolean }

/** Single neurons need an LU Engine piece that is not in 3.0.9 (Zentrale,
 *  31.10.2026: never look broken, say it plainly when applied). */
export const NEURONS_LATER = 'Single neurons arrive with the next LU Engine update. LU already reads, checks and shares these lines.'

/** Whether a recipe line can run on this model, and if not, why. */
export function entryState(e: RecipeEntry, info: NeuronInfoPlus, vectorIds: ReadonlySet<string>, ids: { feature: (n: number) => string; neuron: (l: number, n: number) => string; own: (e: Extract<RecipeEntry, { kind: 'own' }>) => string }): EntryState {
  switch (e.kind) {
    case 'preset':
      if (vectorIds.has(e.id)) return { state: 'ready' }
      return info.generator ? { state: 'prepare' } : { state: 'blocked', why: 'This install is missing its vector tool.' }
    case 'own':
      if (vectorIds.has(ids.own(e))) return { state: 'ready' }
      return info.generator ? { state: 'prepare' } : { state: 'blocked', why: 'This install is missing its vector tool.' }
    case 'feature':
      if (!info.sae) return { state: 'blocked', why: 'This model has no feature data (only Gemma 3 270M IT and 1B IT have).' }
      if (e.feature >= info.sae.width) return { state: 'blocked', why: `This model's features go up to #${info.sae.width - 1}.` }
      if (vectorIds.has(ids.feature(e.feature))) return { state: 'ready' }
      return info.sae.downloaded ? { state: 'prepare' } : { state: 'blocked', why: 'Download the feature data first (Features tab).' }
    case 'neuron':
      if (e.layer >= info.facts.nLayer) return { state: 'blocked', why: `This model has ${info.facts.nLayer} layers (0–${info.facts.nLayer - 1}).` }
      if (info.nFf && e.neuron >= info.nFf) return { state: 'blocked', why: `Layers of this model have ${info.nFf} neurons.` }
      if (vectorIds.has(ids.neuron(e.layer, e.neuron))) return { state: 'ready' }
      if (!info.mlpNeurons) return { state: 'blocked', why: NEURONS_LATER, later: true }
      return { state: 'prepare' }
  }
}

function describe(e: RecipeEntry, presetName: (id: string) => string): string {
  switch (e.kind) {
    case 'preset': return `Ready-made slider ${presetName(e.id)} at ${signedValue(e.strength)}`
    case 'feature': return `Feature #${e.feature} at ${signedValue(e.strength)}`
    case 'neuron': return `Layer ${e.layer}, neuron ${e.neuron}, pushed ${e.dose < 0 ? 'down' : 'up'} by ${Math.abs(e.dose).toFixed(2)}`
    case 'own': return `Your-own slider “${e.name}” at ${signedValue(e.strength)}, from ${e.more.length} + ${e.less.length} example lines`
  }
}

const KIND_LABEL: Record<RecipeEntry['kind'], string> = { preset: 'Ready-made', feature: 'Feature', neuron: 'Neuron', own: 'From examples' }

export const COORD_EXAMPLES = [
  { label: 'Cheerful and brief', text: '@cheerful+0.50 @detailed-0.40' },
  { label: 'Calm and formal', text: '@cheerful-0.30 @casual-0.50' },
  { label: 'A shared neuron (Qwen3.5-4B)', text: 'Qwen3.5-4B: L13N7956-1.0 L14N8949+1.0' },
]

export function CoordinatesPanel({ presets, modelNames, states, onUse, disabled }: {
  presets: Array<{ id: string; left: string; right: string }>
  modelNames: Array<string | null | undefined>
  states: (e: RecipeEntry) => EntryState
  onUse: (recipe: Recipe) => void
  disabled: boolean
}) {
  const [text, setText] = useState('')
  const [anyway, setAnyway] = useState(false)
  const [laterNote, setLaterNote] = useState<string | null>(null)
  const presetIds = useMemo(() => new Set(presets.map((p) => p.id)), [presets])
  const parsed = useMemo(() => (text.trim() ? parseRecipe(text, presetIds) : null), [text, presetIds])
  const fit: ModelFit = parsed?.ok ? modelFit(parsed.recipe.model, ...modelNames) : 'unknown'
  const bound = (e: RecipeEntry) => e.kind === 'neuron' || e.kind === 'feature'
  const modelBound = parsed?.ok && parsed.recipe.entries.some(bound)
  // The "anyway" box only where it would change something.
  const boundUsable = parsed?.ok && parsed.recipe.entries.some((e) => bound(e) && states(e).state !== 'blocked')
  const presetName = (id: string) => {
    const p = presets.find((x) => x.id === id)
    return p ? `${p.left} ↔ ${p.right}` : id
  }
  const usable = parsed?.ok ? parsed.recipe.entries.filter((e) => states(e).state !== 'blocked') : []
  const later = parsed?.ok ? parsed.recipe.entries.filter((e) => { const st = states(e); return st.state === 'blocked' && !!st.later }) : []
  const blockedByModel = fit === 'other' && boundUsable && !anyway
  return (
    <div className="space-y-3" data-testid="neuron-coords">
      <label className="block t-body text-gray-200">
        <span className="block mb-1 font-medium">Paste coordinates or an LU link</span>
        <textarea
          rows={3}
          value={text}
          onChange={(e) => { setText(e.target.value); setAnyway(false); setLaterNote(null) }}
          placeholder={'Qwen3.5-4B: L13N7956-1.0 L14N8949+1.0\n@cheerful+0.5 F11690+0.8\nlocallyuncensored://neuron?v=1&…'}
          spellCheck={false}
          className={`${field} t-mono`}
          data-testid="neuron-coords-input"
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`t-micro ${HINWEIS_TEXT.ruhig} mr-1`}>Try:</span>
        {COORD_EXAMPLES.map((x) => (
          <button key={x.text} type="button" onClick={() => setText(x.text)} className="lu-control lu-control--outline t-micro" title={x.text}>{x.label}</button>
        ))}
      </div>

      {parsed && !parsed.ok && <Hinweis ton="fehler"><span data-testid="neuron-coords-error">{parsed.error}</span></Hinweis>}

      {parsed?.ok && (
        <div className="space-y-2" data-testid="neuron-coords-preview">
          <p className="t-body text-gray-200">
            {parsed.recipe.model ? <>Made on <span className="font-medium">{parsed.recipe.model}</span>. </> : null}
            {fit === 'same' && <span className="text-emerald-600 dark:text-emerald-400">That is the model you picked.</span>}
            {fit === 'other' && <span className="font-medium text-gray-900 dark:text-white" data-testid="neuron-coords-other-model">You picked another model.{modelBound ? ' Neuron and feature numbers belong to one exact model; on another they point at something unrelated.' : ' Ready-made and own sliders are computed fresh for yours, so they still work.'}</span>}
          </p>
          <ul className="divide-y divide-gray-100 dark:divide-white/[0.05] rounded-lg border border-gray-200 dark:border-white/[0.06]">
            {parsed.recipe.entries.map((e) => {
              const st = states(e)
              return (
                <li key={entryCode(e)} className="grid grid-cols-[6.5rem_1fr_auto] items-start gap-3 px-3 py-2" data-testid="neuron-coords-line">
                  <span className="t-label text-gray-500 pt-1">{KIND_LABEL[e.kind]}</span>
                  <div className="min-w-0">
                    <p className="t-mono text-gray-900 dark:text-white truncate">{entryCode(e)}</p>
                    <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>{describe(e, presetName)}</p>
                    {st.state === 'blocked' && <p className="t-micro text-gray-200 mt-0.5">{st.why}</p>}
                  </div>
                  <span className={`t-micro pt-1 ${st.state === 'ready' ? 'text-emerald-600 dark:text-emerald-400' : st.state === 'prepare' ? 'text-lu-accent' : HINWEIS_TEXT.ruhig}`}>
                    {st.state === 'ready' ? 'Ready' : st.state === 'prepare' ? 'Will be prepared' : st.later ? 'Next update' : 'Not usable'}
                  </span>
                </li>
              )
            })}
          </ul>
          {parsed.notes.map((n) => <p key={n} className={`t-micro ${HINWEIS_TEXT.ruhig}`}>{n}</p>)}
          {fit === 'other' && boundUsable && (
            <label className="flex items-center gap-2 t-body text-gray-200">
              <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} className="accent-lu-accent" data-testid="neuron-coords-anyway" />
              Use the numbers on my model anyway
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              disabled={disabled || (usable.length === 0 && later.length === 0) || blockedByModel}
              onClick={() => {
                if (usable.length) onUse({ model: parsed.recipe.model, entries: usable })
                setLaterNote(later.length
                  ? `${later.length === 1 ? 'One single neuron was' : `${later.length} single neurons were`} not applied. ${NEURONS_LATER}`
                  : null)
              }}
              data-testid="neuron-coords-use"
              className="lu-control lu-primary"
            >
              {usable.length === 0 && later.length === 0 ? 'Nothing usable on this model' : usable.length === parsed.recipe.entries.length || usable.length === 0 ? 'Use these values' : `Use the ${usable.length} usable values`} <ArrowRight size={ICON_SM} />
            </button>
            <span className={`t-micro ${HINWEIS_TEXT.ruhig}`}>{usable.length ? 'Replaces your current sliders. You can undo.' : 'Nothing changes on your sliders.'}</span>
          </div>
          {laterNote && <p className="t-body text-gray-200" role="status" data-testid="neuron-coords-later">{laterNote}</p>}
        </div>
      )}

      <details className="pt-1">
        <summary className={`t-micro ${HINWEIS_TEXT.ruhig} cursor-pointer`}>How coordinates are written</summary>
        <ul className={`t-micro ${HINWEIS_TEXT.ruhig} mt-1.5 space-y-1 list-disc pl-4`}>
          <li><span className="t-mono">L13N7956-1.0</span>: layer 13, MLP neuron 7956, pushed down by 1 (the form shared on neuronary.org and neuron-explorer since October 2026; <span className="t-mono">13:7956:-1.0</span> and <span className="t-mono">L13 N7956 −1.0</span> mean the same). Valid only for the exact model it was found on.</li>
          <li><span className="t-mono">@cheerful+0.5</span>: one of LU’s ready-made sliders. Works on any model, because LU computes it for yours.</li>
          <li><span className="t-mono">F11690+0.8</span>: feature 11690 of the model’s sparse autoencoder (Gemma Scope 2).</li>
          <li>An LU link also carries your own sliders as their example lines. LU reads only numbers and example sentences from a recipe, never files, addresses or commands.</li>
        </ul>
      </details>
    </div>
  )
}

// ── Before and after ──────────────────────────────────────────────────

export function ComparePanel({ modelPath, entries, disabled, model, tuning, onError, onDone }: {
  modelPath: string
  entries: ReturnType<typeof entriesFor>
  disabled: boolean
  model: BundledModel | undefined
  tuning: (m: BundledModel | undefined) => Promise<BuiltinEngineTuning | undefined>
  onError: (e: string) => void
  onDone?: () => void
}) {
  const [question, setQuestion] = useState('Write two sentences about rain.')
  const [seed, setSeed] = useState(42)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<(CompareResult & { entries: typeof entries }) | null>(null)
  const run = async () => {
    setBusy(true)
    try {
      const r = await neuronCompare(modelPath, question, seed, entries, await tuning(model))
      setResult({ ...r, entries })
      onDone?.()
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const stale = result && !sameEntries(result.entries, entries)
  return (
    <div data-testid="neuron-compare" className="space-y-3">
      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <label className="block t-body text-gray-200 min-w-0">
          <span className="block mb-1 font-medium">Question</span>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} data-testid="neuron-compare-question" className={field} />
        </label>
        <label className="block t-body text-gray-200">
          <span className="block mb-1 font-medium">Seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} className={`${fieldBase} w-20`} />
        </label>
        <button type="button" disabled={disabled || busy || !question.trim()} onClick={() => void run()} data-testid="neuron-compare-run" className="lu-control lu-primary h-[34px]">
          {busy && <Loader2 size={ICON_SM} className="animate-spin" />} Compare
        </button>
      </div>
      {entries.length === 0 && !result && <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>All sliders are at 0, so both answers will be the same. Move a slider in step 2 first.</p>}
      {result && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="neuron-compare-result">
            <div className="rounded-lg border border-gray-200 dark:border-white/[0.08] p-3">
              <p className="t-label text-gray-500 mb-1.5">Before · sliders off</p>
              <p className="t-body text-gray-100 whitespace-pre-wrap" data-testid="neuron-compare-before">{result.before}</p>
            </div>
            <div className="rounded-lg border border-lu-accent/40 bg-lu-accent/[0.05] p-3">
              <p className="t-label text-lu-accent mb-1.5">After · {result.entries.map((e) => `${e.id} ${signedValue(e.strength)}`).join(', ') || 'all at 0'}</p>
              <p className="t-body text-gray-100 whitespace-pre-wrap" data-testid="neuron-compare-after">{result.after}</p>
            </div>
          </div>
          <p className={`t-micro ${HINWEIS_TEXT.ruhig}`} data-testid="neuron-compare-same">
            {result.same ? 'Identical answers.' : 'The answers differ.'}{stale ? ' The sliders changed since; compare again.' : ''}
          </p>
        </>
      )}
      <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>Same question, same seed, temperature 0: once with the sliders off, once on. The engine restarts twice.</p>
    </div>
  )
}

// ── Share ─────────────────────────────────────────────────────────────

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function SharePanel({ recipe, skipped, onUndo }: { recipe: Recipe; skipped: string[]; onUndo?: () => void }) {
  const [copied, setCopied] = useState<'' | 'text' | 'link' | 'fail'>('')
  const line = coordsLine(recipe)
  const hasAny = recipe.entries.length > 0
  const flash = (k: 'text' | 'link', ok: boolean) => {
    setCopied(ok ? k : 'fail')
    window.setTimeout(() => setCopied(''), 1800)
  }
  return (
    <div className="space-y-2" data-testid="neuron-share">
      {hasAny ? (
        <>
          <p className="t-body text-gray-200">Your mix as coordinates. Others paste it under <span className="font-medium">Coordinates</span>.</p>
          <pre className="t-mono whitespace-pre-wrap break-all rounded-lg bg-gray-100 dark:bg-white/[0.05] px-3 py-2 text-gray-900 dark:text-white" data-testid="neuron-share-line">
            {[recipe.model, line || null].filter(Boolean).join(' · ')}
            {recipe.entries.some((e) => e.kind === 'own') ? `${line ? ' ' : ''}+ ${recipe.entries.filter((e) => e.kind === 'own').length} own slider(s) in the link` : ''}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="lu-control lu-control--outline" data-testid="neuron-share-copy" onClick={() => void copy(recipeText(recipe)).then((ok) => flash('text', ok))}>
              {copied === 'text' ? <Check size={ICON_SM} /> : <ClipboardCopy size={ICON_SM} />} Copy coordinates
            </button>
            <button type="button" className="lu-control lu-control--outline" data-testid="neuron-share-link" onClick={() => void copy(recipeLink(recipe)).then((ok) => flash('link', ok))}>
              {copied === 'link' ? <Check size={ICON_SM} /> : <Link2 size={ICON_SM} />} Copy link
            </button>
            {copied === 'fail' && <span className="t-micro text-red-600 dark:text-red-400">The clipboard refused. Select the line above and copy it by hand.</span>}
          </div>
          {skipped.length > 0 && <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>Not in the recipe: {skipped.join(', ')}.</p>}
        </>
      ) : (
        <p className={`t-body ${HINWEIS_TEXT.ruhig}`} data-testid="neuron-share-empty">Move a slider first. Your mix then shows here as a short line to copy.</p>
      )}
      {onUndo && (
        <button type="button" className="lu-control" onClick={onUndo} data-testid="neuron-coords-undo">
          <Undo2 size={ICON_SM} /> Undo the recipe
        </button>
      )}
    </div>
  )
}
