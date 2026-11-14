/**
 * Create, 3D to Blender (desktop app only). Rust: src-tauri/src/commands/blender.rs.
 *
 *   getBlenderStatus()                    -> BlenderStatus | null (null: no desktop app)
 *   openInBlender(glb, name)              -> starts Blender with the model, does not wait
 *   makeWithBlender(glb, name, format, job) -> bytes of a .blend or .fbx
 *   stopBlender(job)                      -> stops that run
 *
 * The GLB goes to Rust as the raw body of the call, the name and the format
 * as headers. Rust only ever runs a Blender it found itself.
 */
import { isTauri } from './in-tauri'
import { isMobile } from '../lib/device-kind'
import type { GalleryItem } from '../stores/createStore'

export interface BlenderStatus {
  found: boolean
  version: string | null
  tooOld: boolean
  source: string | null
}

export type BlenderFormat = 'blend' | 'fbx'

/** True where Blender can be asked for at all: the desktop app. */
export function blenderPossible(): boolean {
  return isTauri() && !isMobile()
}

async function invoke<T>(cmd: string, args?: unknown, headers?: Record<string, string>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(cmd, args as Record<string, unknown> | Uint8Array | undefined, headers ? { headers } : undefined)
}

let cached: { at: number; status: BlenderStatus } | null = null
const FRESH_MS = 30_000

/** Asked when the Download menu opens. A Blender installed while LU runs is
 *  seen after half a minute. */
export async function getBlenderStatus(): Promise<BlenderStatus | null> {
  if (!blenderPossible()) return null
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.status
  try {
    const status = await invoke<BlenderStatus>('blender_status')
    cached = { at: Date.now(), status }
    return status
  } catch {
    return null
  }
}

/** For tests. */
export function forgetBlenderStatus(): void {
  cached = null
}

export function blenderHeaders(name: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-lu-name': encodeURIComponent(name), ...extra }
}

export async function openInBlender(glb: Uint8Array, name: string): Promise<number> {
  return invoke<number>('blender_open', glb, blenderHeaders(name))
}

export async function makeWithBlender(glb: Uint8Array, name: string, format: BlenderFormat, job: string): Promise<Uint8Array> {
  const out = await invoke<ArrayBuffer | Uint8Array | number[]>('blender_convert', glb, blenderHeaders(name, { 'x-lu-format': format, 'x-lu-job': job }))
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer)
}

export async function stopBlender(job: string): Promise<void> {
  try {
    await invoke<boolean>('blender_cancel', { job })
  } catch {
    // Nothing running any more.
  }
}

/** What the model is called in Blender: the first words of its prompt, or
 *  the gallery's label for it. */
export function blenderModelName(item: Pick<GalleryItem, 'prompt' | 'label' | 'sourceName'>): string {
  const from = (item.prompt || item.label || item.sourceName || '').replace(/\s+/g, ' ').trim()
  if (!from) return 'LU model'
  if (from.length <= 40) return from
  const cut = from.slice(0, 40)
  // Cut at the last whole word (the cut may already end on one).
  const space = from[40] === ' ' ? 40 : cut.lastIndexOf(' ')
  return (space > 20 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, '')
}

export const BLENDER_TEXT = {
  open: 'Open in Blender',
  blend: 'Save as .blend',
  blendNote: 'textures packed in',
  fbx: 'FBX',
  fbxNote: 'made by Blender, for other 3D apps',
  opening: 'Opening Blender…',
  making: { blend: 'Blender is making the .blend…', fbx: 'Blender is making the FBX…' } as Record<BlenderFormat, string>,
  stop: 'Stop',
  tooOld: (v: string | null) => `Your Blender${v ? ` (${v})` : ''} is too old. Blender 3.3 or newer can open it here.`,
  failed: 'Blender could not do it.',
}

export type BlenderAction = 'open' | 'blend' | 'fbx'

export interface BlenderMenuEntry {
  id: BlenderAction
  label: string
  note?: string
}

/** The Blender part of the Download menu. Empty without a usable Blender. */
export function blenderMenu(status: BlenderStatus | null): BlenderMenuEntry[] {
  if (!status?.found || status.tooOld) return []
  return [
    { id: 'open', label: BLENDER_TEXT.open },
    { id: 'blend', label: BLENDER_TEXT.blend, note: BLENDER_TEXT.blendNote },
    { id: 'fbx', label: BLENDER_TEXT.fbx, note: BLENDER_TEXT.fbxNote },
  ]
}

/** A line under the formats for a Blender too old to use. Without Blender
 *  the GLB entry itself says it is the one for Blender. */
export function blenderMenuHint(status: BlenderStatus | null): string | null {
  return status?.found && status.tooOld ? BLENDER_TEXT.tooOld(status.version) : null
}
