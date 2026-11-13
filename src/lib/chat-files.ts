/**
 * Any file as a chat attachment (3.0.5, a user on Discord: "let me give
 * the model a ROM file").
 *
 * WHAT A MODEL CAN DO WITH A BINARY. Nothing with the bytes themselves: a
 * language model reads text, and base64 pasted into the prompt is neither
 * readable to it nor affordable (a 16 MB ROM is about 21 million characters).
 * So the chat does two honest things instead:
 *
 *   1. Every chat gets a compact description in place of the bytes: name,
 *      size, the type read from the magic bytes, the SHA-256, a hex dump of
 *      the first bytes and the readable strings found inside. All of it in a
 *      fixed budget, a few kilobytes per file whatever the file weighs.
 *   2. In Agent and Code the file is also copied into the chat's working
 *      folder, where the file and shell tools can work on the real thing.
 *      For a binary the model then gets the facts and the path only (3.0.7):
 *      its tools read the bytes far better than a dump in the prompt does.
 *
 * In plain chat the composer says so when a binary is attached: the model
 * only sees the summary, and Agent or Code is where it gets the file
 * (binarySummaryOnlyMessage). Nothing attached is ever run.
 *
 * WHAT IS STORED. Only the description. The file is not copied into the chat
 * history, not as base64 and not as a reference to a stored blob: the history
 * is serialised as one string on every save, and a few large images in it
 * have taken the renderer down before (chat-attachments.ts, the 127 MiB
 * IndexedDB limit). The description is bounded by the constants below.
 *
 * The same text goes out to a local model and to a cloud model: it is part of
 * the user message, so no provider needs to know about it.
 */
import { backendCall } from '../api/backend'
import type { FileAttachment } from '../types/chat'
import { detectFileKind } from './file-magic'
import { formatBytes } from './formatters'
import { log } from './logger'
import { sha256OfBlob } from './sha256-stream'
import { platformText } from './platform-text'

/** How many files one message may carry. */
export const MAX_CHAT_FILES = 3
/** The largest file that can be attached (3.0.7: 256 MB, was 64 MB). The
 *  same number as WRITE_BYTES_CAP in src-tauri/src/commands/filesystem.rs. A
 *  file above WHOLE_READ_BYTES is never held in memory whole: its start is
 *  read for the description and the hash goes through it slice by slice. */
export const MAX_CHAT_FILE_BYTES = 256 * 1024 * 1024
/** Up to this size a file is read in one piece and hashed by WebCrypto. */
export const WHOLE_READ_BYTES = 32 * 1024 * 1024
/** How much of the start of a binary is shown as a hex dump. */
export const HEX_DUMP_BYTES = 256
/** The budget for readable strings, in characters. */
export const STRINGS_BUDGET_CHARS = 3000
/**
 * How much of a text file the chat holds at most, in characters (GH #171).
 *
 * Until 3.0.7 a text file was cut to its first 4000 characters here, before
 * anyone knew which model it was for, and without a word to the user. Now
 * the whole text is held up to this size and the cut, if any, is made at
 * send time against the window of the model it goes to (chat-file-fit.ts),
 * and said. A million characters covers every window a model ships with
 * today, and it bounds what a chat history can grow by per file.
 */
export const TEXT_HOLD_CHARS = 1_048_576
/** A run of printable characters counts as a string from this length on. */
const MIN_STRING_LENGTH = 5
/** One string never takes more of the budget than this. */
const MAX_STRING_LENGTH = 120
/** How far into the file the string scan reads at most. */
export const STRINGS_SCAN_BYTES = 8 * 1024 * 1024
/** The window the type detection looks at. The ISO 9660 signature sits at
 *  0x8001, everything else far earlier. */
const KIND_WINDOW_BYTES = 64 * 1024
/** Raw bytes per call when a file is copied into the working folder. */
const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024

export const TOO_MANY_FILES_MESSAGE = `You can attach up to ${MAX_CHAT_FILES} files per message.`

export function fileTooLargeMessage(name: string): string {
  return `"${cleanFileName(name)}" is too large. You can attach files up to ${formatBytes(MAX_CHAT_FILE_BYTES)}.`
}

/** A file waiting in the composer, or on its way through a send. `file` is the
 *  handle to the bytes; it is absent on a resend, where the stored
 *  description is all that is left and all that is needed. */
export interface ChatFileInput {
  attachment: FileAttachment
  file?: File
  /** One sentence for the user when the file could not be read the way it should be. Not stored. */
  notice?: string
  /** Set for an `@` mention (lib/file-mentions.ts): the path in the working
   *  folder whose token stands in the text. The chip goes with the token. */
  mention?: string
}

/** Reads the text of a PDF or a Word file. Handed in by the phone, which has the reader of the documents of a chat. */
export type DocumentReader = (file: File) => Promise<string>

export interface PrepareOptions {
  readDocument?: DocumentReader
}

/** A document the reader above can open. */
const DOCUMENT_NAME = /\.(pdf|docx)$/i

/** Longest wait for the text of a document before the file counts as unreadable. */
export const DOCUMENT_READ_MS = 30_000

/** What the model reads for a document whose text could not be had. It never gets the bytes of it. */
export const UNREADABLE_DOCUMENT_SUMMARY =
  'The text of this document could not be read. It may be scanned pictures, protected or damaged. You do not know what it says: tell the user that, and do not guess.'

export function unreadableDocumentNotice(name: string): string {
  return `The text of "${cleanFileName(name)}" could not be read. The model only gets its name.`
}

/** Pure: the text of a document as the model reads it, in the budget of a text file. Null when there is nothing to read. */
export function describeDocumentText(raw: string, label: string): string | null {
  const text = raw
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length === 0) return null
  const excerpt = text.slice(0, TEXT_HOLD_CHARS)
  return excerpt.length === text.length
    ? `The whole text of the ${label}:\n${excerpt}`
    : `The ${label} is longer than this excerpt. The first ${excerpt.length} characters of its text:\n${excerpt}`
}

/**
 * A file name as one harmless line: no path, no control characters, no line
 * break that could end the attachment block early, and not endless.
 */
export function cleanFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? ''
  const base = Array.from(last, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
    .join('')
    .replace(/[[\]]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return 'file'
  return base.length > 120 ? `${base.slice(0, 117)}...` : base
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** The classic sixteen-per-line dump: offset, hex bytes, printable column. */
export function hexDump(bytes: Uint8Array, limit = HEX_DUMP_BYTES): string {
  const end = Math.min(bytes.length, limit)
  const lines: string[] = []
  for (let at = 0; at < end; at += 16) {
    const row = bytes.subarray(at, Math.min(at + 16, end))
    const hex = Array.from(row, hex2)
    while (hex.length < 16) hex.push('  ')
    const shown = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${at.toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${shown}|`)
  }
  return lines.join('\n')
}

/**
 * The readable strings in a binary, in file order, each one once, until the
 * budget is spent. `more` says whether the scan stopped before the end of the
 * file, so the description never claims to be complete when it is not.
 */
export function readableStrings(bytes: Uint8Array, budgetChars = STRINGS_BUDGET_CHARS): { strings: string[]; more: boolean } {
  const strings: string[] = []
  const seen = new Set<string>()
  let used = 0
  const end = Math.min(bytes.length, STRINGS_SCAN_BYTES)
  let start = -1
  for (let i = 0; i <= end; i++) {
    const printable = i < end && bytes[i] >= 0x20 && bytes[i] < 0x7f
    if (printable) {
      if (start < 0) start = i
      continue
    }
    if (start >= 0 && i - start >= MIN_STRING_LENGTH) {
      const length = Math.min(i - start, MAX_STRING_LENGTH)
      let value = ''
      for (let j = start; j < start + length; j++) value += String.fromCharCode(bytes[j])
      value = value.trim()
      if (value.length >= MIN_STRING_LENGTH && !seen.has(value)) {
        if (used + value.length + 1 > budgetChars) return { strings, more: true }
        seen.add(value)
        strings.push(value)
        used += value.length + 1
      }
    }
    start = -1
  }
  return { strings, more: end < bytes.length }
}

/** Why less than the whole text of a file reached the model (GH #171). */
export type FileCutReason = 'context' | 'send-limit' | 'setting' | 'size'

const WHOLE_TEXT_HEADER = 'The whole text of the file:\n'

const count = (n: number): string => n.toLocaleString('en-US')

/** The reason in the words the MODEL reads. */
const CUT_REASON_FOR_MODEL: Record<FileCutReason, string> = {
  context: "the whole file does not fit into your context window next to the conversation and room for your answer",
  'send-limit': 'the whole file does not fit into the send limit set for this model',
  setting: 'the user set a limit for attached files',
  size: 'the file is longer than the chat can hold',
}

/** The summary of a text file that went out whole. */
export function wholeTextSummary(text: string): string {
  return `${WHOLE_TEXT_HEADER}${text}`
}

/** The summary of a text file of which only the start went out. The model is
 *  told how much it got, of how much, and why, so it never mistakes the end of
 *  the excerpt for the end of the file. */
export function cutTextSummary(text: string, total: number | undefined, reason: FileCutReason): string {
  const why = CUT_REASON_FOR_MODEL[reason]
  // `total` is unknown for a file too large to be read in whole.
  const of = total === undefined ? '' : ` of ${count(total)}`
  if (text.length === 0) {
    return `None of the${total === undefined ? '' : ` ${count(total)}`} characters of this file could be included, because ${why}. Tell the user that you cannot see the text.`
  }
  return `Only the first ${count(text.length)}${of} characters of this file are included, because ${why}. The text below stops there; tell the user so if they ask about a later part.\n${text}`
}

/** The text of a text attachment as it is held, or null when there is none
 *  to fit (a binary, or a file stored before 3.0.7, whose excerpt is short). */
export function heldText(file: FileAttachment): string | null {
  if ((file.textChars === undefined && file.includedChars === undefined) || isBinaryAttachment(file)) return null
  if (file.summary.startsWith(WHOLE_TEXT_HEADER)) return file.summary.slice(WHOLE_TEXT_HEADER.length)
  const lineEnd = file.summary.indexOf('\n')
  return lineEnd < 0 ? '' : file.summary.slice(lineEnd + 1)
}

/** What the model reads in place of the bytes. Pure, so it can be tested on a
 *  handful of bytes. `bytes` may be only the start of the file; `totalSize`
 *  then says how long the whole file is, so the summary never claims to have
 *  seen all of it. */
export function describeFileBytes(
  bytes: Uint8Array,
  name: string,
  totalSize = bytes.length,
): { kind: string; summary: string; binary: boolean; textChars?: number; includedChars?: number } {
  const kind = detectFileKind(bytes.subarray(0, KIND_WINDOW_BYTES), name)
  if (bytes.length === 0) return { kind: 'Empty file', summary: 'The file is empty.', binary: false }
  if (kind.isText) {
    // The bytes may end inside a multi-byte character when they are only the
    // start of the file; a lenient decoder turns that into one replacement
    // character, which is cut off below.
    const all = bytes.length === totalSize
    const raw = new TextDecoder('utf-8').decode(bytes)
    const decoded = all ? raw : raw.replace(/�+$/, '')
    const held = decoded.slice(0, TEXT_HOLD_CHARS)
    if (all && held.length === decoded.length) {
      return { kind: kind.label, binary: false, summary: wholeTextSummary(held), textChars: held.length }
    }
    // Longer than the chat holds. When the whole file was read its length is
    // known and the model is told it; a file read only at its start is not.
    if (all) {
      return {
        kind: kind.label,
        binary: false,
        summary: cutTextSummary(held, decoded.length, 'size'),
        textChars: decoded.length,
        includedChars: held.length,
      }
    }
    return {
      kind: kind.label,
      binary: false,
      summary: cutTextSummary(held, undefined, 'size'),
      includedChars: held.length,
    }
  }
  const shown = Math.min(bytes.length, HEX_DUMP_BYTES)
  const found = readableStrings(bytes)
  const { strings } = found
  const more = found.more || totalSize > bytes.length
  const parts = [
    'This is a binary file. Its bytes cannot be shown to you, so this is a summary of it.',
    `Hex dump of the first ${shown} bytes:\n${hexDump(bytes)}`,
  ]
  if (strings.length > 0) {
    parts.push(
      `Readable strings found in the file${more ? ' (the first ones, there are more)' : ''}:\n${strings.join('\n')}`,
    )
  } else {
    parts.push('No readable strings were found in the file.')
  }
  return { kind: kind.label, summary: parts.join('\n\n'), binary: true }
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash), hex2).join('')
}

/**
 * Read a picked file and build its description. Refuses a file over the limit
 * before reading a byte of it. A small file is read once; a large one only
 * at its start, and its hash is taken slice by slice.
 */
export async function prepareChatFile(file: File, options: PrepareOptions = {}): Promise<ChatFileInput> {
  if (file.size > MAX_CHAT_FILE_BYTES) throw new Error(fileTooLargeMessage(file.name))
  const name = cleanFileName(file.name)
  let head: Uint8Array
  let sha256: string
  try {
    if (file.size <= WHOLE_READ_BYTES) {
      const buffer = await file.arrayBuffer()
      head = new Uint8Array(buffer)
      sha256 = await sha256Hex(buffer)
    } else {
      head = new Uint8Array(await file.slice(0, STRINGS_SCAN_BYTES).arrayBuffer())
      sha256 = await sha256OfBlob(file)
    }
  } catch {
    throw new Error(`"${name}" could not be read.`)
  }
  const size = file.size <= WHOLE_READ_BYTES ? head.byteLength : file.size
  const described = describeFileBytes(head, name, size)
  const { kind, summary, binary, textChars, includedChars } = described
  // A PDF or a Word file is read the way the documents of a chat are read. Its bytes are no summary: a
  // compressed PDF was handed to the model as a hex dump, and the answer came from nothing (round 23, N15).
  if (options.readDocument && size > 0 && (DOCUMENT_NAME.test(name) || kind === 'PDF document')) {
    let text: string | null = null
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), DOCUMENT_READ_MS)
      })
      try {
        text = describeDocumentText(await Promise.race([options.readDocument(file), limit]), /\.docx$/i.test(name) ? 'Word document' : 'PDF')
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      log.warn('[chat-files] the text of a document could not be read', { err: String(err) })
    }
    if (text) return { attachment: { name, size, kind, sha256, summary: text }, file }
    return { attachment: { name, size, kind, sha256, summary: UNREADABLE_DOCUMENT_SUMMARY }, file, notice: unreadableDocumentNotice(name) }
  }
  return {
    attachment: {
      name, size, kind, sha256, summary,
      ...(binary ? { binary: true } : {}),
      ...(textChars !== undefined ? { textChars } : {}),
      ...(includedChars !== undefined ? { includedChars } : {}),
    },
    file,
  }
}

/** Whether the model got a binary summary for this file. Attachments stored
 *  before 3.0.7 carry no flag; their summary says it in its first words. */
export function isBinaryAttachment(file: FileAttachment): boolean {
  return file.binary ?? file.summary.startsWith('This is a binary file.')
}

/**
 * The line above the transcript when a binary is attached in plain chat: the
 * model cannot read the bytes, it gets the summary, and Agent or Code is
 * where it gets the file itself. Null when no file needs it.
 */
export function binarySummaryOnlyMessage(files: readonly FileAttachment[]): string | null {
  const binaries = files.filter(isBinaryAttachment)
  if (binaries.length === 0) return null
  const list = binaries.map((file) => `"${file.name}" (${file.kind}, ${formatBytes(file.size)})`).join(', ')
  return `Models cannot read binary files. ${list} ${binaries.length > 1 ? 'reach the model as short summaries' : 'reaches the model as a short summary'} only. To let it work on the file itself, turn on Agent mode or use Code: the file is then put into the working folder, where the model's tools can open it.`
}

/** The block one file contributes to the user message. */
export function fileBlock(file: FileAttachment, surface: 'chat' | 'workspace'): string {
  const binary = isBinaryAttachment(file)
  const facts = [
    `[Attached file: ${file.name}]`,
    `Type: ${file.kind}`,
    `Size: ${formatBytes(file.size)} (${file.size} bytes)`,
    `SHA-256: ${file.sha256}`,
  ]
  // A binary in the working folder: the facts and the path. The tools read
  // the bytes; a dump of them here would only cost context.
  // Discord feature request, 03.10.2026: "load binary files (such as ROMs)
  // directly". The working folder path is what LU's own file and shell tools
  // take; a tool of a plugin (REA's open_binary) runs in its own folder and
  // needs the full path.
  const full = file.absolutePath ? `Full path on this computer: ${file.absolutePath}` : null
  if (file.workspacePath && binary) {
    return [
      ...facts,
      `Path in your working folder: ${file.workspacePath}`,
      ...(full ? [full] : []),
      `This is a binary file, so its bytes are not shown here. Inspect it with your file and shell tools on that path, for example a hex dump or a short Python script${full ? ', or hand the full path to a reverse engineering tool that opens a file by its path' : ''}. Do not run the file or open it as a program unless the user asks you to.`,
      `[End of attached file: ${file.name}]`,
    ].join('\n')
  }
  // The sentence differs on a phone (no shell there); the full path, when
  // there is one, stands right under the working folder path.
  const inWorkspace = file.workspacePath ? platformText('attachedFileInWorkspace', { path: file.workspacePath }) : null
  const where = inWorkspace
    ? (full ? inWorkspace.replace('\n', `\n${full}\n`) : inWorkspace)
    : surface === 'workspace'
      ? 'The file could not be copied into your working folder. Only this summary is available.'
      : binary
        ? 'The file itself is not available to you in this chat. Only this summary is. You cannot read its bytes here; if the user needs more than the summary answers, tell them to turn on Agent mode or use Code, where your tools can open the file itself.'
        : 'The file itself is not available to you in this chat. Only this summary is.'
  return [
    ...facts,
    where,
    '',
    file.summary,
    `[End of attached file: ${file.name}]`,
  ].join('\n')
}

/**
 * The text a turn's tools are picked from (lib/tool-selection): what was
 * typed, plus one line per binary in the working folder. The REA plugin's
 * tools are picked by the words of a turn (lib/plugins/rea-tools), and a ROM
 * dropped in with "what is this?" named none of them, so the file tools and
 * REA's opening tools stayed out of a turn that had a binary to open.
 */
export function toolRoutingText(typed: string, files: readonly FileAttachment[] | undefined): string {
  const binaries = (files ?? []).filter((f) => f.workspacePath && isBinaryAttachment(f))
  if (binaries.length === 0) return typed
  return [typed, ...binaries.map((f) => `inspect the attached binary file ${f.name} (${f.kind})`)].join('\n')
}

/** What the user typed when a message carries nothing but files. */
export const FILE_ONLY_TEXT = '(file)'

/**
 * The user message as the model receives it: what was typed, then one block
 * per file. Without files the text comes back untouched.
 */
export function composeFileMessage(typed: string, files: readonly FileAttachment[] | undefined, surface: 'chat' | 'workspace' = 'chat'): string {
  if (!files?.length) return typed
  return [typed, ...files.map((file) => fileBlock(file, surface))].join('\n\n')
}

/**
 * The three fields a user message gets from its files: `content` is what the
 * model reads (typed text plus one block per file), `displayContent` is what
 * the user typed and what the bubble shows, `files` draws the chips and lets a
 * resend rebuild the message. Without files only `content` comes back, so a
 * message without attachments is stored exactly as before.
 */
export function fileMessageFields(
  typed: string,
  files: readonly FileAttachment[] | undefined,
  surface: 'chat' | 'workspace' = 'chat',
): { content: string; displayContent?: string; files?: FileAttachment[] } {
  if (!files?.length) return { content: typed }
  return { content: composeFileMessage(typed, files, surface), displayContent: typed, files: [...files] }
}

/**
 * The attachments of a send that has no working folder (plain chat, a group
 * round, Chat Tools). A path from an earlier Agent turn is dropped: this
 * surface has no tool that could open it, and the block must not say it has.
 */
export function filesWithoutWorkspace(inputs: readonly ChatFileInput[] | undefined): FileAttachment[] | undefined {
  if (!inputs?.length) return undefined
  return inputs.map(({ attachment }) => {
    const { workspacePath: _dropped, ...rest } = attachment
    return rest
  })
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(binary)
}

/** `rom.gba` taken: `rom (1).gba`, `rom (2).gba`, and so on. */
export function numberedFileName(name: string, n: number): string {
  if (n === 0) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

/** `/home/x`, `C:\x`, `C:/x` or a network share: a path that names its drive. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Where the working folder of a run is, in the words the fs commands take. */
export interface ChatFileWorkspace {
  chatId: string
  workingDirectory?: string
}

const TAKEN = /already exists/i

async function uploadFile(file: File, workspace: ChatFileWorkspace): Promise<{ path: string; absolute?: string }> {
  const name = cleanFileName(file.name)
  for (let n = 0; n < 50; n++) {
    const path = numberedFileName(name, n)
    try {
      let offset = 0
      let saved: unknown = null
      do {
        const chunk = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer())
        const last = offset + chunk.length >= file.size
        saved = await backendCall('fs_write_bytes', { path, base64: toBase64(chunk), offset, last, ...workspace })
        offset += chunk.length
      } while (offset < file.size)
      // The last chunk answers with the full path it renamed the file to.
      const answered = saved && typeof saved === 'object' ? (saved as { path?: unknown }).path : undefined
      const absolute = typeof answered === 'string' && isAbsolutePath(answered) ? answered : undefined
      return { path, ...(absolute ? { absolute } : {}) }
    } catch (err) {
      // The folder may be the user's real project. A name that is taken there
      // is never overwritten; the attachment gets the next free one.
      if (TAKEN.test(err instanceof Error ? err.message : String(err))) continue
      throw err
    }
  }
  throw new Error('No free file name in the working folder.')
}

/**
 * Copy the attached files into the working folder of an Agent or Code run.
 *
 * Never throws and never blocks the send: a file that cannot be copied (disk
 * full, a browser session without a backend, a resend of a message whose
 * bytes are long gone) keeps its description, and the block the model reads
 * says that only the summary is available. `failed` names those files so the
 * caller can tell the user.
 */
export async function placeChatFiles(
  inputs: readonly ChatFileInput[],
  workspace: ChatFileWorkspace,
): Promise<{ files: FileAttachment[]; failed: string[] }> {
  const files: FileAttachment[] = []
  const failed: string[] = []
  for (const { attachment, file } of inputs) {
    // Already in the folder: a resend, or the same message sent again.
    if (attachment.workspacePath || !file) {
      files.push(attachment)
      continue
    }
    try {
      const placed = await uploadFile(file, workspace)
      files.push({ ...attachment, workspacePath: placed.path, ...(placed.absolute ? { absolutePath: placed.absolute } : {}) })
    } catch (err) {
      log.warn('[chat-files] the attachment could not be copied into the working folder', { err: String(err) })
      failed.push(attachment.name)
      files.push(attachment)
    }
  }
  return { files, failed }
}

export function copyFailedMessage(names: readonly string[]): string {
  const list = names.map((name) => `"${name}"`).join(', ')
  return `${list} could not be copied into the working folder. The model only gets a summary of it.`
}
