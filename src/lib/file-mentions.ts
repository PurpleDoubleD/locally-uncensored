/**
 * `@` file mentions in the composer (U8, like Claude Code, Cursor and Zed).
 *
 * Typing `@` at the start of the field or after a space opens a list of the
 * files of the working folder. A picked file becomes a token in the text
 * (`@src/math.ts`) and a chip in the attachment row, and it travels the SAME
 * way as a file dropped onto the composer: one `ChatFileInput` in the draft,
 * one block in the user message (lib/chat-files.ts, `fileBlock`). There is no
 * second path to the model.
 *
 * What is different from a dropped file: the file is already in the working
 * folder, so the attachment carries its `workspacePath` from the start and
 * `placeChatFiles` never copies it. A mention is text only: a binary file is
 * refused with a short note (the clip is the way for those), and a secret
 * file (.env, keys, tokens) is refused by the same rules that stop the
 * agent's own tools (lib/secret-paths.ts, C59).
 *
 * The folder is read with `fs_list` one level at a time, the way the Explorer
 * does, so node_modules and friends are skipped before they are listed: a
 * recursive listing stops at 500 entries, and one npm install fills that on
 * its own.
 */
import { backendCall } from '../api/backend'
import type { FsListResult, FsReadResult } from '../types/bridge'
import type { FileAttachment } from '../types/chat'
import type { ChatFileInput } from './chat-files'
import { cutTextSummary, wholeTextSummary } from './chat-files'
import { EXPLORER_IGNORED, FS_LIST_CAP } from './explorer-tree'
import { detectFileKind } from './file-magic'
import { secretPathReason } from './secret-paths'

/** Where the files of a mention come from, in the words the fs commands take. */
export interface MentionRoot {
  /** The real project folder (Code tab, a pinned Agent folder). */
  workingDirectory?: string
  /** The per-chat sandbox, when no real folder is set. */
  chatId?: string
}

/** One file or folder of the working folder, as the popup lists it. */
export interface MentionEntry {
  /** Path inside the working folder, forward slashes, no leading `./`. */
  rel: string
  /** The path the backend named; handed back verbatim when it is read. */
  abs: string
  isDir: boolean
  size: number
  /** Unix seconds, 0 when unknown. */
  modified: number
  depth: number
}

export interface MentionIndex {
  entries: MentionEntry[]
  /** The walk stopped at one of its limits, so the list is not the whole folder. */
  truncated: boolean
}

/** A text mention goes out up to this many characters, the rest is cut with a note. */
export const MENTION_TEXT_CAP = 64 * 1024
/** Rows the popup shows at most. */
export const MENTION_MENU_MAX = 50
/** Mentions one message may carry. Dropped files have their own limit. */
export const MAX_MENTIONS = 5
/** Lines of a folder listing at most. */
export const MENTION_FOLDER_MAX = 200

/** The walk's limits: files collected, folders listed, depth. */
const WALK_MAX_FILES = 5000
const WALK_MAX_DIRS = 400
const WALK_MAX_DEPTH = 8

/**
 * Folders nobody means when they type `@`: the Explorer's list
 * (lib/explorer-tree.ts) plus the caches and environments of other stacks.
 */
export const MENTION_IGNORED: ReadonlySet<string> = new Set([
  ...EXPLORER_IGNORED,
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', 'coverage',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.gradle', '.idea', '.DS_Store', 'Thumbs.db',
])

/** Endings that are never text, refused before a byte is read. */
const BINARY_ENDINGS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'heic',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'mp4', 'mov', 'mkv', 'webm', 'avi',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'dmg', 'iso', 'jar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'wasm', 'pyc',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt',
  'ttf', 'otf', 'woff', 'woff2', 'sqlite', 'db', 'safetensors', 'gguf', 'ckpt', 'pt', 'onnx',
])

/* ---------- the trigger ---------- */

export interface MentionQuery {
  /** Index of the `@` in the text. */
  start: number
  /** What was typed after the `@`, up to the caret. */
  query: string
}

/**
 * The mention the caret is in, or null. An `@` counts at the start of the
 * text or after whitespace or an opening bracket, so `name@host` never
 * opens the list. The query ends at the caret and holds no whitespace.
 */
export function mentionAt(text: string, caret: number | null | undefined): MentionQuery | null {
  const end = caret == null ? text.length : Math.max(0, Math.min(caret, text.length))
  let i = end - 1
  while (i >= 0 && !/\s/.test(text[i]) && text[i] !== '@') i--
  if (i < 0 || text[i] !== '@') return null
  const before = i === 0 ? '' : text[i - 1]
  if (before && !/[\s([{]/.test(before)) return null
  const query = text.slice(i + 1, end)
  if (query.includes('@')) return null
  return { start: i, query }
}

/** The path a pick stands for in the field: a folder ends in `/`. */
export function mentionPath(entry: Pick<MentionEntry, 'rel' | 'isDir'>): string {
  return entry.isDir ? `${entry.rel.replace(/\/+$/, '')}/` : entry.rel
}

/** The text of a mention as it stands in the field. Paths with spaces are quoted. */
export function mentionToken(rel: string): string {
  return /\s/.test(rel) ? `@"${rel}"` : `@${rel}`
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the field still holds the token of `rel` as a word of its own. */
export function hasMentionToken(text: string, rel: string): boolean {
  const re = new RegExp(`(^|[\\s([{])${escapeRe(mentionToken(rel))}(?=$|[\\s,;:!?)\\]}'"]|\\.(?:\\s|$))`)
  return re.test(text)
}

/** The field without the token of `rel` (the chip's x takes both away). */
export function removeMentionToken(text: string, rel: string): string {
  const re = new RegExp(`(^|[\\s([{])${escapeRe(mentionToken(rel))} ?`)
  return text.replace(re, '$1')
}

/**
 * The field after a pick: the typed `@query` becomes the token plus a space,
 * and the caret goes behind it.
 */
export function insertMention(text: string, at: MentionQuery, caret: number, rel: string): { text: string; caret: number } {
  const token = `${mentionToken(rel)} `
  const tail = text.slice(Math.max(caret, at.start)).replace(/^\S*/, '').replace(/^ /, '')
  const head = text.slice(0, at.start)
  return { text: head + token + tail, caret: head.length + token.length }
}

/* ---------- the filter ---------- */

/** A score for `query` against `rel`; higher is better, null is no match. */
export function mentionScore(query: string, rel: string): number | null {
  const q = query.toLowerCase().replace(/^\.\//, '')
  if (!q) return 0
  const path = rel.toLowerCase()
  const base = path.replace(/\/$/, '').split('/').pop() ?? path
  if (base === q || path === q) return 1000
  if (base.startsWith(q)) return 800 - base.length
  if (path.startsWith(q)) return 700 - path.length
  const inBase = base.indexOf(q)
  if (inBase >= 0) return 600 - inBase
  const inPath = path.indexOf(q)
  if (inPath >= 0) return 500 - inPath
  // Fuzzy: every character in order. A run of matches and a match at the
  // start of a segment count more; gaps count against.
  let score = 300
  let at = -1
  let run = 0
  for (const ch of q) {
    const next = path.indexOf(ch, at + 1)
    if (next < 0) return null
    if (next === at + 1) run++
    else { score -= Math.min(next - at - 1, 20); run = 0 }
    if (next === 0 || path[next - 1] === '/' || path[next - 1] === '.' || path[next - 1] === '-' || path[next - 1] === '_') score += 4
    score += run * 2
    at = next
  }
  return score
}

/**
 * The rows for the popup: matching entries, best first. Without a query the
 * shallow and the recently changed come first, so `@` alone shows the top of
 * the project instead of a deep file nobody looks for.
 */
export function rankMentions(entries: readonly MentionEntry[], query: string, limit = MENTION_MENU_MAX): MentionEntry[] {
  const scored: { e: MentionEntry; s: number }[] = []
  for (const e of entries) {
    const s = mentionScore(query, e.isDir ? `${e.rel}/` : e.rel)
    if (s !== null) scored.push({ e, s })
  }
  scored.sort((a, b) =>
    b.s - a.s
    || a.e.depth - b.e.depth
    || b.e.modified - a.e.modified
    || a.e.rel.length - b.e.rel.length
    || a.e.rel.localeCompare(b.e.rel))
  return scored.slice(0, limit).map((x) => x.e)
}

/* ---------- reading the folder ---------- */

export type FsCall = <T>(command: string, args: Record<string, unknown>) => Promise<T>

const defaultFs: FsCall = (command, args) => backendCall(command, args)

/** A stable key for a root, for the cache and for React. */
export function mentionRootKey(root: MentionRoot | null | undefined): string {
  if (!root) return ''
  return root.workingDirectory ? `dir:${root.workingDirectory}` : root.chatId ? `chat:${root.chatId}` : ''
}

/**
 * Walk the working folder breadth first, one `fs_list` per folder, skipping
 * the ignored folders before they are listed. Stops at its limits and says so.
 */
export async function buildMentionIndex(root: MentionRoot, fs: FsCall = defaultFs): Promise<MentionIndex> {
  const entries: MentionEntry[] = []
  let truncated = false
  let listed = 0
  const queue: { path: string; rel: string; depth: number }[] = [{ path: '.', rel: '', depth: 0 }]
  while (queue.length > 0) {
    if (listed >= WALK_MAX_DIRS || entries.length >= WALK_MAX_FILES) { truncated = true; break }
    const dir = queue.shift()!
    listed++
    let data: FsListResult | null
    try {
      data = await fs<FsListResult>('fs_list', { path: dir.path, recursive: false, pattern: null, ...root })
    } catch (err) {
      // The root itself unreadable is an error for the caller; a subfolder is skipped.
      if (dir.depth === 0) throw err
      continue
    }
    const raw = Array.isArray(data?.entries) ? data!.entries : []
    if (raw.length >= FS_LIST_CAP) truncated = true
    for (const item of raw) {
      const name = typeof item?.name === 'string' ? item.name : ''
      if (!name || name === '.' || name === '..' || MENTION_IGNORED.has(name)) continue
      const rel = dir.rel ? `${dir.rel}/${name}` : name
      const depth = dir.depth + 1
      const entry: MentionEntry = {
        rel,
        abs: typeof item.path === 'string' && item.path ? item.path : rel,
        isDir: !!item.isDir,
        size: typeof item.size === 'number' ? item.size : 0,
        modified: typeof item.modified === 'number' ? item.modified : 0,
        depth,
      }
      entries.push(entry)
      if (entry.isDir && depth < WALK_MAX_DEPTH) queue.push({ path: entry.abs, rel, depth })
      if (entries.length >= WALK_MAX_FILES) { truncated = true; break }
    }
  }
  return { entries, truncated }
}

const CACHE_MS = 15_000
const cache = new Map<string, { at: number; index: Promise<MentionIndex> }>()

/** The index of a root, read again after a few seconds so new files show up. */
export function mentionIndexFor(root: MentionRoot, fs: FsCall = defaultFs, now = Date.now()): Promise<MentionIndex> {
  const key = mentionRootKey(root)
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.index
  const index = buildMentionIndex(root, fs)
  cache.set(key, { at: now, index })
  index.catch(() => cache.delete(key))
  return index
}

/** Only for tests. */
export function __clearMentionCache(): void {
  cache.clear()
}

/* ---------- a pick becomes an attachment ---------- */

export type MentionResult =
  | { ok: true; input: ChatFileInput }
  | { ok: false; note: string }

/** One path as a harmless label: no control characters, no brackets that could end the block early. */
export function mentionLabel(rel: string): string {
  const clean = Array.from(rel, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
    .join('')
    .replace(/[[\]]/g, '_')
    .trim()
  if (!clean) return 'file'
  return clean.length > 160 ? `...${clean.slice(-157)}` : clean
}

/** Why a mention may not be sent, or null. Checks the path in the folder and the path the backend named. */
export function mentionSecretReason(entry: Pick<MentionEntry, 'rel' | 'abs'>): string | null {
  return secretPathReason(entry.rel) ?? secretPathReason(entry.abs)
}

export function secretMentionNote(rel: string, why: string): string {
  return `${rel} stays private: it holds ${why}. LU never sends secret files to a model.`
}

export function binaryMentionNote(rel: string): string {
  return `${rel} is not a text file, so it was not attached. Use the clip to attach it instead.`
}

export function unreadableMentionNote(rel: string): string {
  return `${rel} could not be read.`
}

export const TOO_MANY_MENTIONS_MESSAGE = `You can mention up to ${MAX_MENTIONS} files per message.`

const ending = (rel: string) => /\.([a-z0-9]+)$/i.exec(rel)?.[1]?.toLowerCase() ?? ''

/** Text that came out of a binary: a NUL, or many replacement characters. */
export function looksBinaryText(text: string): boolean {
  if (text.includes('\u0000')) return true
  const sample = text.slice(0, 8192)
  if (!sample) return false
  let bad = 0
  for (const ch of sample) if (ch === '�') bad++
  return bad / sample.length > 0.02
}

async function sha256Text(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Pure: the summary of a text mention, whole or cut at the cap with a note. */
export function mentionTextFields(text: string): Pick<FileAttachment, 'summary' | 'textChars' | 'includedChars'> {
  if (text.length === 0) return { summary: 'The file is empty.' }
  if (text.length <= MENTION_TEXT_CAP) return { summary: wholeTextSummary(text), textChars: text.length }
  const held = text.slice(0, MENTION_TEXT_CAP)
  return { summary: cutTextSummary(held, text.length, 'size'), textChars: text.length, includedChars: held.length }
}

/** Pure: the listing of a folder as the model reads it. */
export function folderListing(rel: string, items: readonly { name: string; isDir: boolean; size: number }[]): string {
  const shown = items.slice(0, MENTION_FOLDER_MAX)
  const lines = shown.map((i) => (i.isDir ? `${i.name}/` : `${i.name} (${i.size} bytes)`))
  const more = items.length > shown.length ? `\n(${items.length - shown.length} more entries not shown.)` : ''
  return `The folder ${rel}/ in the working folder, one level, ${items.length} entries:\n${lines.join('\n')}${more}`
}

/**
 * Read a picked entry and turn it into the attachment a dropped file would
 * be. Never throws: a refusal comes back as one short sentence for the user.
 */
export async function loadMention(root: MentionRoot, entry: MentionEntry, fs: FsCall = defaultFs): Promise<MentionResult> {
  const rel = entry.isDir ? entry.rel.replace(/\/+$/, '') : entry.rel
  const label = mentionLabel(rel)
  const why = mentionSecretReason(entry)
  if (why) return { ok: false, note: secretMentionNote(label, why) }

  if (entry.isDir) {
    let data: FsListResult | null
    try {
      data = await fs<FsListResult>('fs_list', { path: entry.abs, recursive: false, pattern: null, ...root })
    } catch {
      return { ok: false, note: unreadableMentionNote(label) }
    }
    const items = (Array.isArray(data?.entries) ? data!.entries : [])
      .filter((i) => typeof i?.name === 'string' && i.name && !MENTION_IGNORED.has(i.name))
      // A secret file is not named in a listing either.
      .filter((i) => !secretPathReason(`${rel}/${i.name}`))
      .map((i) => ({ name: i.name, isDir: !!i.isDir, size: typeof i.size === 'number' ? i.size : 0 }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    const summary = folderListing(label, items)
    return {
      ok: true,
      input: {
        // The size is that of the listing the model gets, not of the folder.
        attachment: { name: `${label}/`, size: new TextEncoder().encode(summary).length, kind: 'Folder listing', sha256: await sha256Text(summary), summary, workspacePath: `${rel}/` },
        mention: mentionPath(entry),
      },
    }
  }

  if (BINARY_ENDINGS.has(ending(rel))) return { ok: false, note: binaryMentionNote(label) }
  let read: FsReadResult | null
  try {
    read = await fs<FsReadResult>('fs_read', { path: entry.abs, ...root })
  } catch {
    return { ok: false, note: unreadableMentionNote(label) }
  }
  if (!read || read.encoding !== 'utf8' || typeof read.content !== 'string') return { ok: false, note: binaryMentionNote(label) }
  const text = read.content
  if (looksBinaryText(text)) return { ok: false, note: binaryMentionNote(label) }
  const bytes = new TextEncoder().encode(text)
  const kind = detectFileKind(bytes.subarray(0, 64 * 1024), rel)
  if (!kind.isText && bytes.length > 0) return { ok: false, note: binaryMentionNote(label) }
  return {
    ok: true,
    input: {
      attachment: {
        name: label,
        size: bytes.length,
        kind: bytes.length === 0 ? 'Empty file' : kind.label,
        sha256: await sha256Text(text),
        ...mentionTextFields(text),
        workspacePath: rel,
      },
      mention: rel,
    },
  }
}
