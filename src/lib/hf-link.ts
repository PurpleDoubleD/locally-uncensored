/**
 * Hugging Face "Use this model" (B17, 3.0.9): what the page does with a
 * `locallyuncensored://open-model?repo=<owner/name>&file=<path.gguf>` link.
 *
 * Rust reads the link and checks it (src-tauri/src/hf_link.rs) before it
 * lands in the inbox. The page checks the same rules again on what it takes
 * out: the inbox is the only door, and a second lock on it costs nothing.
 * Nothing here downloads. The address is always built from the repository id
 * and always points at huggingface.co, and the download waits for the user
 * (HfLinkDialog).
 */

import type { DiscoverModel } from '../api/model-bundles'
import type { HfGgufResolution } from '../api/discover'
import { shardSetGap, type ShardGap } from './gguf-shards'

export interface HfModelLink {
  repo: string
  /** Null when the button was pressed without a file picked. */
  file: string | null
}

export type HfLinkInbound =
  | { kind: 'model'; link: HfModelLink }
  | { kind: 'rejected'; reason: string }

/** Hugging Face's rule for an owner and for a repository name. */
function validNamePart(s: string): boolean {
  return s.length > 0 && s.length <= 96
    && /^[A-Za-z0-9._-]+$/.test(s)
    && !/^[-.]|[-.]$/.test(s)
    && !s.includes('--') && !s.includes('..')
}

export function isValidRepoId(repo: string): boolean {
  const parts = repo.split('/')
  return parts.length === 2 && parts.every(validNamePart)
}

/** A plain relative path inside the repository that ends in `.gguf`. */
export function isValidGgufPath(path: string): boolean {
  if (path.length === 0 || path.length > 255) return false
  if (!/\.gguf$/i.test(path)) return false
  const segments = path.split('/')
  if (segments.length > 8) return false
  if (!segments.every((seg) => seg.length > 0 && !seg.startsWith('.') && /^[A-Za-z0-9._-]+$/.test(seg))) return false
  return segments[segments.length - 1].length > '.gguf'.length
}

const REJECTED_FALLBACK = 'The link could not be read.'

/** What `hf_link_take` answered, checked again. Anything else is null. */
export function readInbound(raw: unknown): HfLinkInbound | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'rejected') {
    // The sentence comes from Rust and never carries the link. Shown as text,
    // never as markup, and cut short in case.
    const reason = typeof r.reason === 'string' && r.reason.length <= 200 ? r.reason : REJECTED_FALLBACK
    return { kind: 'rejected', reason }
  }
  if (r.kind !== 'model' || typeof r.repo !== 'string' || !isValidRepoId(r.repo)) return null
  const file = r.file == null ? null : r.file
  if (file !== null && (typeof file !== 'string' || !isValidGgufPath(file))) return null
  return { kind: 'model', link: { repo: r.repo, file } }
}

/** The repository page, for the "view on Hugging Face" line. */
export function hfRepoPage(repo: string): string {
  return `https://huggingface.co/${repo}`
}

/** The tree the dialog reads sizes and files from. */
export function hfTreeApi(repo: string): string {
  return `https://huggingface.co/api/models/${repo}/tree/main?recursive=true`
}

/** One file, or one split set, the user can pick. */
export interface HfLinkChoice {
  /** Path of the file, or of the first part of a split set. */
  path: string
  quant?: string
  bytes: number
  parts: number
  /** A split set the repository holds only some parts of. It cannot be
   *  loaded, so it is shown but not downloaded. */
  incomplete?: ShardGap
}

const SHARD_RE = /-(\d{4,5})-of-(\d{4,5})\.gguf$/i
const QUANT_RE = /(IQ\d_[A-Z0-9]+|Q\d_K(?:_[A-Z]+)?|Q\d_[01]|BF16|F16|F32)/i
const IMAGE_PART_RE = /(^|\/)[^/]*mmproj[^/]*\.gguf$/i

interface TreeEntry { type?: string; path?: string; size?: number }

/**
 * Every model GGUF in a repository tree, one row per file or split set,
 * smallest first. Image parts (mmproj) are not models and are left out: the
 * download brings them along with the model they belong to.
 */
export function ggufChoicesFromTree(entries: unknown): HfLinkChoice[] {
  if (!Array.isArray(entries)) return []
  const groups = new Map<string, HfLinkChoice & { first: number; paths: string[] }>()
  for (const e of entries as TreeEntry[]) {
    if (e?.type !== 'file' || typeof e.path !== 'string' || !/\.gguf$/i.test(e.path)) continue
    if (IMAGE_PART_RE.test(e.path)) continue
    const shard = SHARD_RE.exec(e.path)
    const key = e.path.replace(SHARD_RE, '')
    const index = shard ? parseInt(shard[1], 10) : 0
    const leaf = (e.path.split('/').pop() || '').replace(SHARD_RE, '.gguf')
    const g = groups.get(key) ?? { path: e.path, quant: (QUANT_RE.exec(leaf)?.[1] ?? QUANT_RE.exec(e.path)?.[1])?.toUpperCase(), bytes: 0, parts: 0, first: index, paths: [] }
    g.bytes += typeof e.size === 'number' ? e.size : 0
    g.parts += 1
    g.paths.push(e.path)
    if (index < g.first) { g.first = index; g.path = e.path }
    groups.set(key, g)
  }
  return [...groups.values()]
    .map(({ first: _first, paths, ...c }) => {
      const gap = shardSetGap(paths)
      return gap ? { ...c, incomplete: gap } : c
    })
    .sort((a, b) => a.bytes - b.bytes || a.path.localeCompare(b.path))
}

/**
 * The choice the link names, or null when the repository has no such model
 * file. Strict on purpose: the file the link names, by its full path, or a
 * part of that split set. No guessing by leaf name or quant, so a link never
 * downloads something other than what it says.
 */
export function choiceForFile(choices: readonly HfLinkChoice[], file: string): HfLinkChoice | null {
  const key = file.replace(SHARD_RE, '')
  return choices.find((c) => c.path === file || c.path.replace(SHARD_RE, '') === key && SHARD_RE.test(file)) ?? null
}

/** The row preselected when the link names no file: Q4_K_M, else the
 *  smallest, a complete one before an incomplete split set. */
export function defaultChoice(choices: readonly HfLinkChoice[]): HfLinkChoice | null {
  const loadable = choices.filter((c) => !c.incomplete)
  return loadable.find((c) => c.quant === 'Q4_K_M') ?? loadable[0] ?? choices[0] ?? null
}

/** The line a split set with parts missing gets. */
export function incompleteLabel(gap: ShardGap): string {
  return `incomplete: ${gap.have} of ${gap.of} parts, try again later`
}

/** "1.2 GB", "380 MB". */
export function sizeLabel(bytes: number): string {
  if (!bytes) return 'size unknown'
  const gb = bytes / 1_073_741_824
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1_048_576))} MB`
}

/**
 * The entry the Models page downloads, built from the resolved files. It
 * goes through the same door as a card from the list, so the file lands
 * where the active chat backend reads it (lib/text-download-target.ts).
 */
export function linkModel(repo: string, resolution: HfGgufResolution): DiscoverModel | null {
  const first = resolution.files[0]
  if (!first) return null
  // Only addresses this module can account for: huggingface.co, the
  // repository the user agreed to.
  const prefix = `https://huggingface.co/${repo}/resolve/main/`
  if (!resolution.files.every((f) => f.url.startsWith(prefix))) return null
  const stem = first.filename.replace(SHARD_RE, '').replace(/\.gguf$/i, '')
  return {
    name: stem,
    description: `${repo} on Hugging Face`,
    pulls: '',
    tags: [],
    updated: '',
    url: hfRepoPage(repo),
    downloadUrl: first.url,
    filename: first.filename,
    sizeBytes: resolution.sharded ? undefined : first.sizeBytes || undefined,
    sizeGB: resolution.totalBytes ? +(resolution.totalBytes / 1_073_741_824).toFixed(2) : undefined,
  }
}
