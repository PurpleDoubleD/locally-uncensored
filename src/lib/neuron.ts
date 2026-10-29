// The Neuron tweaker's rules that need no backend: which slider values apply
// to which chat, how a job's progress reads, when to warn.

import type { NeuronEntry, NeuronJob } from '../api/neuron'

/** Slider values by vector id, −1 … +1. */
export type Strengths = Record<string, number>

/** All profiles: one per model, and optionally one per model and persona. */
export type Profiles = Record<string, Strengths>

export function modelProfileKey(modelKey: string): string {
  return modelKey
}

export function personaProfileKey(modelKey: string, personaId: string): string {
  return `${modelKey}::persona:${personaId}`
}

/** A persona's own profile wins over the model's; without one the model's
 *  applies. */
export function effectiveStrengths(profiles: Profiles, modelKey: string, personaId: string | null | undefined): Strengths {
  if (personaId) {
    const own = profiles[personaProfileKey(modelKey, personaId)]
    if (own) return own
  }
  return profiles[modelProfileKey(modelKey)] ?? {}
}

export function hasPersonaProfile(profiles: Profiles, modelKey: string, personaId: string): boolean {
  return personaProfileKey(modelKey, personaId) in profiles
}

export function clampStrength(v: number): number {
  if (!Number.isFinite(v)) return 0
  // Two decimals, so a slider dragged back to the middle is exactly 0 and the
  // mix (and with it the engine) is exactly the unsteered one.
  const r = Math.round(Math.max(-1, Math.min(1, v)) * 100) / 100
  return Math.abs(r) < 0.02 ? 0 : r
}

/** What goes to Rust: only sliders that are on and computed for this model. */
export function entriesFor(strengths: Strengths, available: ReadonlySet<string>): NeuronEntry[] {
  return Object.entries(strengths)
    .map(([id, s]) => ({ id, strength: clampStrength(s) }))
    .filter((e) => e.strength !== 0 && available.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function sameEntries(a: NeuronEntry[], b: NeuronEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.id === b[i].id && e.strength === b[i].strength)
}

export type StrengthWarning = null | 'strong' | 'overload'

/** Each slider's ±1 is just under where its own answer broke when measured.
 *  Near that, and with several sliders pushing at once, text can still turn
 *  odd on other questions. */
export function strengthWarning(entries: NeuronEntry[]): StrengthWarning {
  const load = entries.reduce((sum, e) => sum + Math.abs(e.strength), 0)
  if (load > 1.5) return 'overload'
  if (entries.some((e) => Math.abs(e.strength) > 0.75) || load > 1) return 'strong'
  return null
}

export function warningText(w: StrengthWarning): string | null {
  if (w === 'overload') return 'Several strong sliders at once: answers may repeat themselves or fall apart. Turn some down.'
  if (w === 'strong') return 'High strength: the effect is strongest here, and so is the risk of odd or repeating text.'
  return null
}

export function shortDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

function mb(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

/** Share done, 0…1, or null when it is not known yet. */
export function jobShare(job: NeuronJob): number | null {
  if (job.bytesTotal > 0) return Math.min(1, job.bytesDone / job.bytesTotal)
  if (job.total > 0) return Math.min(1, job.step / job.total)
  return null
}

/** One line under the bar: "12 MB of 42 MB · 29% · 3.1 MB/s · 9 s left" for
 *  a download, "Example 12 of 40 · 30% · 20 s left" for a computation. */
export function jobProgressText(job: NeuronJob): string {
  const parts: string[] = []
  const share = jobShare(job)
  if (job.bytesTotal > 0) {
    parts.push(`${mb(job.bytesDone)} of ${mb(job.bytesTotal)}`)
  } else if (job.total > 0) {
    parts.push(job.kind === 'build' && /example/i.test(job.phaseLabel) ? `Example ${job.step} of ${job.total}` : `Step ${job.step} of ${job.total}`)
  }
  if (share != null) parts.push(`${Math.round(share * 100)}%`)
  if (job.bytesTotal > 0 && job.rateBps > 0) parts.push(`${(job.rateBps / 1e6).toFixed(1)} MB/s`)
  if (job.etaSecs != null && job.status === 'running' && share != null && share < 1) parts.push(`${shortDuration(job.etaSecs)} left`)
  if (parts.length === 0 && job.elapsedSecs > 0) parts.push(`running for ${shortDuration(job.elapsedSecs)}`)
  return parts.join(' · ')
}

/** Where the tweaker works, in one line for the panel. */
export type BackendKind = 'lu-engine' | 'ollama' | 'lmstudio' | 'cloud' | 'other' | 'none'

export function backendNote(kind: BackendKind): string | null {
  switch (kind) {
    case 'lu-engine':
      return null
    case 'ollama':
      return 'Your chat model runs in Ollama. Ollama takes no control vectors, so the sliders cannot reach it. Load the same model in LU Engine to tweak it.'
    case 'lmstudio':
      return 'Your chat model runs in LM Studio, which takes no control vectors. Load it in LU Engine to tweak it.'
    case 'cloud':
      return 'Cloud models run on servers that take no control vectors from LU. The tweaker works with local LU Engine models.'
    case 'other':
      return 'Your chat model is answered by another program, which takes no control vectors from LU. The tweaker works with LU Engine models.'
    case 'none':
      return 'Pick or download a model for LU Engine to start.'
  }
}
