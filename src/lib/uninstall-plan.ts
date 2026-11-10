/**
 * C17 (Discord feature-requests 30.10.2026): uninstall a model
 * with one click, all its files, instead of hunting the text encoder and the
 * VAE of a 30 GB video model down one by one under Installed.
 *
 * What goes is decided here, pure, from three things the caller asks the disk
 * and the catalog: which bundle the file belongs to, which of the bundle's
 * files are on the disk (and where), and which other bundles are installed.
 * The dialog shows exactly this list before anything is deleted, so a file
 * that is kept says why it is kept.
 *
 * Nothing outside LU's own folders goes: a file in the user's own model
 * folder (Storage) and a file another installed model still needs are kept,
 * and both are named.
 */
import type { ModelBundle } from '../api/model-bundles'

export type UninstallKind = 'comfy' | 'engine' | 'ollama'

export interface UninstallFile {
  /** What the dialog shows. */
  label: string
  /** What the delete is called with: the ComfyUI file name, or the GGUF path. */
  ref: string
  /** Where it lies on the disk, when that is known. */
  path?: string
  bytes: number
  action: 'delete' | 'keep'
  /** Why a kept file stays. */
  reason?: string
}

export interface UninstallPlan {
  kind: UninstallKind
  /** The model the dialog is about. */
  title: string
  files: UninstallFile[]
  /** The sum of the files that go. */
  freeBytes: number
  /** One more sentence where one is due (a file that more than one model
   *  shares, a model Ollama manages). */
  note?: string
}

/** What `comfy_model_info` said about a file, or null when it is not there. */
export interface FileOnDisk { path: string; bytes: number; ownFolder: boolean; copies: number }

const leaf = (name: string) => name.split(/[\\/]/).pop() ?? name

/** The bundles of the catalog one ComfyUI file belongs to, by its file name. */
export function bundlesWithFile(file: string, bundles: readonly ModelBundle[]): ModelBundle[] {
  const want = leaf(file).toLowerCase()
  return bundles.filter((b) => b.files.some((f) => f.filename && leaf(f.filename).toLowerCase() === want))
}

function total(files: UninstallFile[]): number {
  return files.filter((f) => f.action === 'delete').reduce((s, f) => s + f.bytes, 0)
}

/** Why a file found on the disk stays, or undefined when it may go. */
function keepReason(found: FileOnDisk, usedBy: string[]): string | undefined {
  if (found.ownFolder) return 'In your own model folder (Storage). LU does not delete there.'
  if (found.copies > 1) return 'There is more than one copy in the model folders. Remove the right one in the ComfyUI folder.'
  if (usedBy.length) return `Still needed by ${usedBy.join(', ')}.`
  return undefined
}

/**
 * The plan for a whole bundle: every file of it that is on the disk.
 * `installed` names the bundles whose files are all there; a file one of
 * those (other than this one) also lists stays.
 */
export function bundleUninstallPlan(
  bundle: ModelBundle,
  allBundles: readonly ModelBundle[],
  installed: Readonly<Record<string, boolean>>,
  onDisk: ReadonlyMap<string, FileOnDisk | null>,
): UninstallPlan {
  const others = allBundles.filter((b) => b.name !== bundle.name && installed[b.name])
  const seen = new Set<string>()
  const files: UninstallFile[] = []
  for (const f of bundle.files) {
    if (!f.filename || seen.has(f.filename)) continue
    seen.add(f.filename)
    const found = onDisk.get(f.filename)
    if (!found) continue
    const usedBy = bundlesWithFile(f.filename, others).map((b) => b.name)
    const reason = keepReason(found, usedBy)
    files.push({
      label: f.name || f.filename,
      ref: f.filename,
      path: found.path,
      bytes: found.bytes,
      action: reason ? 'keep' : 'delete',
      ...(reason ? { reason } : {}),
    })
  }
  return { kind: 'comfy', title: bundle.name, files, freeBytes: total(files) }
}

/**
 * The plan for one row of Installed (image or video). A file that belongs to
 * exactly one bundle takes that bundle's other files along: that is the
 * one-click uninstall. A file several bundles share (a VAE, a text encoder)
 * is only itself, and the sentence says which models will miss it.
 */
export function installedFileUninstallPlan(
  name: string,
  allBundles: readonly ModelBundle[],
  installed: Readonly<Record<string, boolean>>,
  onDisk: ReadonlyMap<string, FileOnDisk | null>,
): UninstallPlan {
  const owners = bundlesWithFile(name, allBundles)
  if (owners.length === 1) {
    const plan = bundleUninstallPlan(owners[0], allBundles, installed, onDisk)
    // The row the user clicked is in it, whatever the catalog spells it.
    if (plan.files.some((f) => leaf(f.ref).toLowerCase() === leaf(name).toLowerCase())) return plan
  }
  const found = onDisk.get(name) ?? onDisk.get(leaf(name)) ?? null
  const files: UninstallFile[] = []
  if (found) {
    const reason = keepReason(found, [])
    files.push({ label: leaf(name), ref: name, path: found.path, bytes: found.bytes, action: reason ? 'keep' : 'delete', ...(reason ? { reason } : {}) })
  }
  const needing = owners.filter((b) => installed[b.name]).map((b) => b.name)
  return {
    kind: 'comfy',
    title: leaf(name),
    files,
    freeBytes: total(files),
    ...(needing.length > 1 ? { note: `This file is shared: ${needing.join(', ')} need it and stop working without it.` } : {}),
  }
}

/** The plan for an LU Engine row, from the files the backend says go. */
export function engineUninstallPlan(title: string, files: readonly { path: string; bytes: number }[]): UninstallPlan {
  const rows: UninstallFile[] = files.map((f) => ({
    label: leaf(f.path),
    ref: f.path,
    path: f.path,
    bytes: f.bytes,
    action: 'delete',
  }))
  return { kind: 'engine', title, files: rows, freeBytes: total(rows) }
}

/** The plan for an Ollama model. Ollama keeps its files as shared layers,
 *  so LU can name the model's size and not the files. */
export function ollamaUninstallPlan(name: string, bytes: number): UninstallPlan {
  return {
    kind: 'ollama',
    title: name,
    files: [{ label: name, ref: name, bytes, action: 'delete' }],
    freeBytes: bytes,
    note: 'Ollama removes this model. Layers another Ollama model shares stay, so the space freed can be smaller.',
  }
}
