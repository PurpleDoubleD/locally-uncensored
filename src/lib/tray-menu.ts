// The grey lines of the tray menu (T2, 3.0.9). The Rust side
// (src-tauri/src/tray_menu.rs) only lays them out; what they say is decided
// here, where the account, the engine and the model are known.
//
// Both states have the same build, as David asked for after the mocks:
//
//   LU Cloud · Signed in            Local · LU Engine
//   ● Hosted Pro plan · active      ● Qwen3 8B · ready
//   1,240 credits left              Memory 9.2 of 24 GB
//   Plan & Credits…                 Models…
//
// No e-mail address in the menu (David, 31.10.), only "Signed in".

import { PLAN_NAMES } from './past-due'

export type TrayDot = 'green' | 'amber' | 'grey'
export interface TrayLine {
  text: string
  dot?: TrayDot
}
export interface TrayStatus {
  lines: TrayLine[]
  action: 'plan' | 'models' | null
}

export interface TrayCloudInput {
  signedIn: boolean
  /** Still asking the server: say nothing about the plan yet. */
  probing: boolean
  tier: string | null
  licenseActive: boolean
  pastDue: boolean
  /** Monthly allowance left plus bought credits, null when unknown. */
  credits: number | null
}

export function planName(tier: string): string {
  return PLAN_NAMES[tier] ?? tier.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function cloudTrayStatus(c: TrayCloudInput): TrayStatus {
  if (c.probing) return { lines: [{ text: 'LU Cloud · Connecting…' }], action: 'plan' }
  if (!c.signedIn) return { lines: [{ text: 'LU Cloud · Signed out' }], action: 'plan' }
  const lines: TrayLine[] = [{ text: 'LU Cloud · Signed in' }]
  if (c.pastDue) {
    lines.push({ text: `${c.tier ? `${planName(c.tier)} plan` : 'Plan'} · payment failed`, dot: 'amber' })
  } else if (c.licenseActive && c.tier) {
    lines.push({ text: `${planName(c.tier)} plan · active`, dot: 'green' })
  } else {
    lines.push({ text: 'No active plan', dot: 'grey' })
  }
  if (c.credits !== null) {
    lines.push({ text: `${Math.max(0, Math.floor(c.credits)).toLocaleString('en-US')} credits left` })
  }
  return { lines, action: 'plan' }
}

/** How far the selected model is, as the menu says it. */
export type TrayModelState = 'ready' | 'loading' | 'idle' | 'engine-off' | 'unknown'

export interface TrayLocalInput {
  /** "LU Engine", "Ollama", "LM Studio", … null when no model is selected. */
  engine: string | null
  model: string | null
  state: TrayModelState
  memory: { label: string; usedGb: number; totalGb: number } | null
}

const STATE_WORDS: Record<TrayModelState, { word: string; dot: TrayDot } | null> = {
  ready: { word: 'ready', dot: 'green' },
  loading: { word: 'loading', dot: 'amber' },
  // Not in memory yet; the first message loads it. Normal, so not amber.
  idle: { word: 'loads on first chat', dot: 'grey' },
  'engine-off': { word: 'not running', dot: 'amber' },
  // A server LU does not ask (LM Studio, vLLM, …): the name alone.
  unknown: null,
}

export function localTrayStatus(l: TrayLocalInput): TrayStatus {
  const lines: TrayLine[] = [{ text: l.engine ? `Local · ${l.engine}` : 'Local' }]
  if (!l.model) {
    lines.push({ text: 'No model selected', dot: 'grey' })
  } else {
    const s = STATE_WORDS[l.state]
    lines.push(s ? { text: `${l.model} · ${s.word}`, dot: s.dot } : { text: l.model })
  }
  if (l.memory && l.memory.totalGb > 0) {
    lines.push({ text: `${l.memory.label} ${l.memory.usedGb.toFixed(1)} of ${Math.round(l.memory.totalGb)} GB` })
  }
  return { lines, action: 'models' }
}
