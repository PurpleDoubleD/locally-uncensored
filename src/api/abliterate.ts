// Remove refusals from a local model (A14). The work happens in Rust and
// Python (src-tauri/src/commands/abliterate); this is the app's side of it.

import { backendCall } from './backend'

export type LicenseKind = 'free' | 'notice'
export type DeviceKind = 'apple' | 'nvidia' | 'amd'
export type Mode = 'gentle' | 'balanced' | 'strong'

export interface LicenseVerdict {
  id: string | null
  kind: LicenseKind
  label: string
  link: string | null
  note: string | null
  cloudAllowed: boolean
}

export interface DeviceOption {
  id: string
  kind: DeviceKind
  name: string
  memoryBytes: number | null
  supported: boolean
  note: string | null
}

export interface Estimate {
  fits: boolean
  whyNot: string | null
  quantization: 'none' | 'bnb4bit'
  memoryNeededBytes: number
  memoryAvailableBytes: number | null
  diskNeededBytes: number
  diskAfterBytes: number
  diskFreeBytes: number | null
  downloadBytes: number
  minutesLow: number
  minutesHigh: number
  outputQuant: string
  outputBytes: number
}

export interface DevicePlan {
  device: DeviceOption
  estimate: Estimate
  estimate100: { minutesLow: number; minutesHigh: number }
}

export interface Plan {
  model: { name: string; path: string; size: number; quant: string }
  alreadyDone?: boolean
  /** null: the file names no original. The dialog asks for the repo. */
  source?: {
    repo: string
    from: 'source' | 'license' | 'catalog' | 'base_model' | 'typed'
    revision: string
    gated: boolean
    private: boolean
    params: number
    downloadBytes: number
    modelType: string | null
    tokenSaved: boolean
  } | null
  license?: LicenseVerdict
  devices?: DevicePlan[]
  quantizeTool?: boolean
  heretic?: string
  cloud?: { available: boolean; allowed: boolean; note: string }
}

export interface Check {
  refusals: number
  falseAlarms: number
  mmlu: number
  n: number
  /** MMLU questions asked; records before 3.0.9 asked `n`. */
  mmluN?: number | null
  /** '1' right, '0' wrong per question, same order in both checks. */
  mmluMarks?: string | null
}

export interface RunRecord {
  id: string
  sourcePath: string
  sourceName: string
  outputPath: string
  outputName: string
  repo: string
  revision: string
  license: string
  mode: Mode
  trials: number
  trial: number
  kl: number
  searchRefusalsBefore: number | null
  searchRefusalsAfter: number
  searchPrompts: number | null
  before: Check | null
  after: Check | null
  quant: string
  quantNote: string | null
  device: string
  seconds: number
  finishedAt: number
  discarded: boolean
}

export interface RunStatus {
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  id: string
  modelName: string
  sourcePath: string
  repo: string
  phase: string
  phaseLabel: string
  step: number
  total: number
  trials: number
  best: { trial: number; refusals: number; kl: number } | null
  baseRefusals: number | null
  prompts: number | null
  startedAt: number
  elapsedSecs: number
  etaSecs: number | null
  /** step and total count bytes (a download). */
  bytes?: boolean
  rateBps?: number | null
  logs: string[]
  error: string | null
  result: RunRecord | null
  resumable: boolean
}

export interface StartArgs {
  path: string
  repo: string
  revision: string
  device: string
  trials: 100 | 200
  mode: Mode
  acceptLicense: boolean
  adult: boolean
}

export function abliteratePlan(path: string, repo?: string): Promise<Plan> {
  return backendCall<Plan>('abliterate_plan', { path, repo: repo ?? null })
}

export function abliterateStart(args: StartArgs): Promise<RunStatus> {
  return backendCall<RunStatus>('abliterate_start', { args })
}

export function abliterateStatus(): Promise<RunStatus> {
  return backendCall<RunStatus>('abliterate_status')
}

export function abliterateCancel(): Promise<RunStatus> {
  return backendCall<RunStatus>('abliterate_cancel')
}

export function abliterateDismiss(): Promise<RunStatus> {
  return backendCall<RunStatus>('abliterate_dismiss')
}

export function abliterateRuns(): Promise<RunRecord[]> {
  return backendCall<RunRecord[]>('abliterate_runs')
}

export function abliterateTrashCopy(path: string): Promise<{ trashed: boolean }> {
  return backendCall<{ trashed: boolean }>('abliterate_trash_copy', { path })
}

/** The share of the current phase that is done, 0..1, or null when the phase
 *  has no count. */
export function phaseShare(s: Pick<RunStatus, 'step' | 'total'>): number | null {
  if (!s.total || s.total <= 0) return null
  return Math.max(0, Math.min(1, s.step / s.total))
}

/** "about 1 h 20 min", "about 12 min". */
export function roughDuration(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

/** "1–2 h", "25–60 min" from an estimate's range in minutes. */
export function minutesRange(low: number, high: number): string {
  if (high < 60) return `${low}–${high} min`
  const lh = low / 60
  const hh = high / 60
  const f = (x: number) => (x < 10 ? (Math.round(x * 2) / 2).toString() : Math.round(x).toString())
  return low < 60 ? `${low} min – ${f(hh)} h` : `${f(lh)}–${f(hh)} h`
}

/** Decimal gigabytes, as disks and downloads are sold. */
export function gb(bytes: number | null | undefined): string {
  if (bytes == null) return '?'
  const v = bytes / 1e9
  // LU's own Python (23 MB) read "0.0 GB of 0.0 GB" on the box.
  if (v < 0.1) return `${Math.max(1, Math.round(bytes / 1e6))} MB`
  return v < 10 ? `${v.toFixed(1)} GB` : `${Math.round(v)} GB`
}

/** "740 MB", "1.24 GB": a download as it moves. */
export function sizeText(bytes: number): string {
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`
  return bytes < 10e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e9).toFixed(1)} GB`
}

/** "740 MB of 1.99 GB · 37% · 4.2 MB/s · about 5 min left", the line under
 *  the bar while a run downloads. Speed and time come once Rust has a few
 *  seconds to measure. */
export function downloadLine(s: Pick<RunStatus, 'step' | 'total' | 'rateBps' | 'etaSecs'>): string {
  const parts = [`${sizeText(s.step)} of ${sizeText(s.total)}`]
  const share = phaseShare(s)
  if (share != null) parts.push(`${Math.floor(share * 100)}%`)
  if (s.rateBps != null) parts.push(s.rateBps >= 1e6 ? `${(s.rateBps / 1e6).toFixed(1)} MB/s` : `${Math.round(s.rateBps / 1e3)} kB/s`)
  if (s.etaSecs != null && s.step < s.total) {
    parts.push(s.etaSecs < 60 ? `${Math.max(1, s.etaSecs)} s left` : `about ${roughDuration(s.etaSecs)} left`)
  }
  return parts.join(' · ')
}

export interface MmluVerdict {
  /** Right in the copy minus right in the original. */
  delta: number
  /** Answers that went from right to wrong and the other way, or null when
   *  a record has no marks (before 3.0.9). */
  worse: number | null
  better: number | null
  /** 'loss' and 'gain' only when the change is larger than chance explains. */
  reading: 'same' | 'chance' | 'loss' | 'gain'
  text: string
}

/** The knowledge check, read honestly. Both checks ask the same questions,
 *  so only the answers that changed carry information: with b turned wrong
 *  and c turned right, chance alone gives a net change of about ±2·√(b+c)
 *  (McNemar). Without marks, two totals of the same questions can only be
 *  reported, not judged. */
export function mmluVerdict(before: Check, after: Check): MmluVerdict {
  const n = after.mmluN ?? after.n
  const delta = after.mmlu - before.mmlu
  const signed = delta > 0 ? `+${delta}` : `${delta}`
  const a = before.mmluMarks
  const b = after.mmluMarks
  if (!a || !b || a.length !== b.length) {
    const text = delta === 0
      ? `Same score on ${n} questions`
      : `${signed} of ${n} questions; too few to tell a loss from chance`
    return { delta, worse: null, better: null, reading: delta === 0 ? 'same' : 'chance', text }
  }
  let worse = 0
  let better = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '1' && b[i] === '0') worse++
    else if (a[i] === '0' && b[i] === '1') better++
  }
  const changed = worse + better
  const answers = (k: number) => `${k} answer${k === 1 ? '' : 's'}`
  if (changed === 0) {
    return { delta, worse, better, reading: 'same', text: `All ${n} answers the same as the original` }
  }
  const noise = 2 * Math.sqrt(changed)
  const reading = Math.abs(delta) <= noise ? 'chance' : delta < 0 ? 'loss' : 'gain'
  const verdict = reading === 'chance'
    ? 'within chance'
    : reading === 'loss'
      ? `a real loss of ${((-delta / n) * 100).toFixed(1)} points`
      : `a real gain of ${((delta / n) * 100).toFixed(1)} points`
  return {
    delta, worse, better, reading,
    text: `${answers(worse)} turned wrong, ${answers(better)} turned right (${signed} of ${n}): ${verdict}`,
  }
}
