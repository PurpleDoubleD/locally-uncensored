/**
 * Chat Export — Markdown and JSON formats.
 *
 * When running inside Tauri, the user gets a native "Save As…" dialog to
 * pick the destination. In a plain browser context we fall back to a
 * blob-download.
 */

import type { Conversation, Message } from '../types/chat'
import { isTauri, backendCall } from '../api/backend'
import { displayModelName } from '../api/providers/model-name'
import { originalAttachment } from './chat-attachments'
import { isMobile } from './device-kind'
import { platformText } from './platform-text'
import { saveOrShare, type SaveOutcome } from './save-or-share'
import { conversationModelOf } from './conversation-model'
import { groupSpeakers, groupTurnPersonaId, isGroupChat } from './group-chat'

/** What an export needs of a persona: its id and the name it goes by. */
export type ExportPersona = { id: string; name: string }

/**
 * The persona name a group turn was written as (GH #171), from the record
 * the group chat keeps on each turn (GH #169, groupTurnPersonaId): the
 * persona's current name, or the name it had then when it has been deleted
 * since. Undefined when the turn's model played no persona.
 */
function groupPersonaOf(conversation: Conversation, msg: Message, personas: readonly ExportPersona[]): string | undefined {
  if (!msg.modelId) return undefined
  const speakers = groupSpeakers(conversation.groupModels ?? [], conversation.groupPersonas, personas.map((p) => ({ systemPrompt: '', ...p })))
  const personaId = groupTurnPersonaId(msg, speakers, { groupPersonas: conversation.groupPersonas, personas })
  if (!personaId) return undefined
  const known = personas.find((p) => p.id === personaId)?.name
  if (known) return known
  // The recorded name carries the model when two members shared the persona.
  const recorded = msg.groupSpeakerName
  const shared = ` (${msg.modelId})`
  return recorded?.endsWith(shared) ? recorded.slice(0, -shared.length) : recorded
}

/**
 * The heading of one turn. A group chat used to head every model turn
 * "Assistant", so who said what was lost on export (GH #171); there each
 * model turn is headed by its persona and its model, or by its model alone.
 */
function turnHeading(conversation: Conversation, msg: Message, personas: readonly ExportPersona[]): string {
  if (msg.role === 'user') return 'You'
  if (msg.role === 'assistant' && msg.modelId && isGroupChat(conversation.groupModels)) {
    const model = displayModelName(msg.modelId)
    const persona = groupPersonaOf(conversation, msg, personas)
    return persona ? `${persona} (${model})` : model
  }
  return msg.role === 'assistant' ? 'Assistant' : msg.role
}

export interface MarkdownExportOptions {
  /** The personas a group turn may have been written as (GH #171): with them
   *  each model turn of a group is headed by its persona and its model. */
  personas?: readonly ExportPersona[]
  /**
   * How the model is called in the header line. Without it the stored id is
   * written as it is, as the desktop always did. The phone hands in the name
   * its chat shows: its stored id carries the slot of the engine in front
   * ("openai::Qwen3.5-0.8B-Q4_K_M"), and a reader of the file took that for a
   * chat that ran over OpenAI (acceptance android-4gb, F10).
   */
  modelLabel?: (modelId: string) => string
  /**
   * The text of one message as the file shows it. Without it `content` is
   * written as it is stored, as the desktop always did. The phone hands in
   * the text a reader sees (lib/reader-text.ts): for a message with a file
   * `content` is the frame the model gets, and that frame stood in the
   * export (check 4 on Android, F12).
   */
  messageText?: (message: Conversation['messages'][number]) => string
  /**
   * The heading of one message, when it is not the one of its role. Without
   * it, or when it answers undefined, the role decides, as the desktop always
   * did. The phone hands in "Search result" for what a tool gave back: for a
   * model that is driven by text that is stored as a message of the user, and
   * stood under "### You" (check 4 on an iPhone, N9).
   */
  messageHeading?: (message: Conversation['messages'][number]) => string | undefined
}

/** The second line of the Markdown form: the model, when one is known, and the day the chat began. */
function headerLine(model: string, created: string): string {
  return model ? `_Model: ${model} | ${created}_` : `_${created}_`
}

export function exportAsMarkdown(conversation: Conversation, options: MarkdownExportOptions = {}): string {
  const lines: string[] = []
  lines.push(`# ${conversation.title}`)
  // The model of the last answer, not the conversation field. That field is
  // rewritten every time the picker moves, so an export could name a model
  // that produced none of the text below it (Meldung 4, R5 re-measure
  // 2026-08-30). Old chats whose answers carry no model fall back to the
  // field, which is all that was ever known about them.
  // A chat that never had a model names none: "Model:" with nothing behind it
  // is not an answer.
  const model = conversationModelOf(conversation)
  const created = new Date(conversation.createdAt).toLocaleString()
  lines.push(headerLine(model && options.modelLabel ? options.modelLabel(model) || model : model, created))
  lines.push('')

  if (conversation.systemPrompt) {
    lines.push('## System Prompt')
    lines.push(conversation.systemPrompt)
    lines.push('')
  }

  lines.push('---')
  lines.push('')

  for (const msg of conversation.messages) {
    lines.push(`### ${options.messageHeading?.(msg) ?? turnHeading(conversation, msg, options.personas ?? [])}`)

    if (msg.thinking) {
      lines.push('')
      lines.push('<details><summary>Thinking</summary>')
      lines.push('')
      lines.push(msg.thinking)
      lines.push('')
      lines.push('</details>')
    }

    if (msg.toolCallSummary) {
      lines.push('')
      lines.push(`> Tool: ${msg.toolCallSummary}`)
    }

    lines.push('')
    lines.push(options.messageText ? options.messageText(msg) : msg.content)
    lines.push('')

    if (msg.sources && msg.sources.length > 0) {
      lines.push('**Sources:**')
      for (const src of msg.sources) {
        lines.push(`- ${src.documentName} (chunk ${src.chunkIndex})`)
      }
      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

export function exportAsJSON(conversation: Conversation, personas: readonly ExportPersona[] = []): string {
  const named = withGroupPersonas(conversation, personas)
  // Same rule as the Markdown header: no model, no model field.
  if (named.model?.trim()) return JSON.stringify(named, null, 2)
  const { model: _none, ...withoutModel } = named
  return JSON.stringify(withoutModel, null, 2)
}

/** A group chat with the persona name on every model turn that had one,
 *  as `speakerPersona` next to the model it already carries (GH #171), so a
 *  reader of the file needs no persona list. Any other chat comes back as is. */
function withGroupPersonas(conversation: Conversation, personas: readonly ExportPersona[]): Conversation {
  if (!isGroupChat(conversation.groupModels)) return conversation
  return {
    ...conversation,
    messages: conversation.messages.map((msg) => {
      if (msg.role !== 'assistant' || !msg.modelId) return msg
      const speakerPersona = groupPersonaOf(conversation, msg, personas)
      return speakerPersona ? { ...msg, speakerPersona } : msg
    }),
  }
}

export function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Export a conversation. Returns:
 *  - "saved" + the chosen path (Tauri dialog)
 *  - "cancelled" (user closed the dialog)
 *  - "downloaded" (browser fallback — file landed in the default Downloads folder)
 */
export async function exportConversation(
  conversation: Conversation,
  format: 'markdown' | 'json',
  personas: readonly ExportPersona[] = [],
): Promise<{ status: 'saved' | 'cancelled' | 'downloaded' | 'error'; path?: string; error?: string; missing?: number }> {
  const safeTitle = conversation.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
  const ext = format === 'markdown' ? 'md' : 'json'
  const extLabel = format === 'markdown' ? 'Markdown' : 'JSON'
  const mime = format === 'markdown' ? 'text/markdown' : 'application/json'
  const filename = `${safeTitle}.${ext}`

  // A phone has no Save As and no native export dialog. The export goes to
  // the share sheet (lib/save-or-share.ts), with the images folded back in
  // here, the way the browser build does it.
  if (isMobile()) {
    // The phone exports through its own adapter (src/mobile/screens/chat/parts/adapters/handover.ts), which hands in
    // the name of the catalogue. Should this way ever be taken on a phone, at least the slot in front is not written.
    const content = format === 'markdown' ? exportAsMarkdown(conversation, { modelLabel: displayModelName }) : exportAsJSON(await portableConversation(conversation))
    return exportOutcome(await saveOrShare({ filename, mime, text: content }))
  }

  // Inside Tauri → native Save As dialog + real disk write. A JSON export
  // goes out with its image references, and the native side puts the image
  // bytes back while it streams to the file (export_chats_dialog), so the
  // WebView never holds the full export.
  if (isTauri()) {
    if (format === 'json') return saveNativeExport(exportAsJSON(conversation, personas), filename)
    // The dialog, and a blob download if the Tauri command fails for any reason.
    return exportOutcome(await saveOrShare(
      { filename, mime, text: exportAsMarkdown(conversation, { personas }) },
      { extension: ext, extLabel, anchorOnDialogFailure: true },
    ))
  }

  // Plain browser fallback
  const content = format === 'markdown' ? exportAsMarkdown(conversation, { personas }) : exportAsJSON(await portableConversation(conversation), personas)
  return exportOutcome(await saveOrShare({ filename, mime, text: content }))
}

/** The export's own result shape from the shared one. A share on a phone is a
 *  save without a path. */
function exportOutcome(outcome: SaveOutcome): { status: 'saved' | 'cancelled' | 'downloaded' | 'error'; path?: string; error?: string } {
  switch (outcome.status) {
    case 'saved': return { status: 'saved', path: outcome.path }
    case 'shared': return { status: 'saved' }
    case 'downloaded': return outcome.error ? { status: 'downloaded', error: outcome.error } : { status: 'downloaded' }
    case 'cancelled': return { status: 'cancelled' }
    default: return { status: 'error', error: outcome.error }
  }
}

async function saveNativeExport(content: string, defaultName: string): Promise<{ status: 'saved' | 'cancelled' | 'error'; path?: string; error?: string; missing?: number }> {
  try {
    const outcome = await backendCall<{ path: string; missing: number } | null>('export_chats_dialog', { content, defaultName })
    if (!outcome) return { status: 'cancelled' }
    return { status: 'saved', path: outcome.path, missing: outcome.missing }
  } catch (e) {
    return { status: 'error', error: `Could not export chats: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The line a UI shows after a saved export. */
export function missingImagesNote(missing: number | undefined): string {
  if (!missing) return ''
  return ` ${missing} image${missing === 1 ? ' was' : 's were'} no longer on ${platformText('thisComputer')} and could not be included.`
}

// ── Bulk backup (a user 2026-06-28: the web build has no store_backup.json,
// so a tunnel/origin change loses chats). Export ALL conversations to one JSON
// file the user can re-import into any LU (web or desktop). ─────────────────

export interface ChatExportBundle {
  /** 'lu' is what a store build of the phone writes. No reader asks for the field (parseImportedChats). */
  app: 'locally-uncensored' | 'lu'
  kind: 'chat-export'
  version: 1
  exportedAt: number
  count: number
  conversations: Conversation[]
}

export function serializeAllConversations(conversations: Conversation[], app: ChatExportBundle['app'] = 'locally-uncensored'): string {
  const bundle: ChatExportBundle = {
    app,
    kind: 'chat-export',
    version: 1,
    exportedAt: Date.now(),
    count: conversations.length,
    conversations,
  }
  return JSON.stringify(bundle, null, 2)
}

/**
 * Export every conversation to a single JSON backup. Tauri → native Save As;
 * browser → blob download (the whole point for web users on a tunnel).
 */
export async function exportAllConversations(
  conversations: Conversation[],
): Promise<{ status: 'saved' | 'cancelled' | 'downloaded' | 'error'; path?: string; count: number; error?: string; missing?: number }> {
  const count = conversations.length
  const filename = `locally-uncensored-chats-${count}.json`

  if (isTauri() && !isMobile()) return { ...(await saveNativeExport(serializeAllConversations(conversations), filename)), count }

  // Browser build, and a phone (share sheet instead of the native dialog).
  const portable: Conversation[] = []
  for (const conversation of conversations) portable.push(await portableConversation(conversation))
  const outcome = await saveOrShare({ filename, mime: 'application/json', text: serializeAllConversations(portable) })
  return { ...exportOutcome(outcome), count }
}

/**
 * Parse an exported file back into conversations. Accepts three shapes:
 *  - a bundle `{ conversations: [...] }` (export-all),
 *  - a bare array `[...]`,
 *  - a single conversation `{ id, messages, ... }` (per-chat .json export).
 * Returns only structurally-valid conversations (string id + title + messages
 * array). Throws on unparseable JSON or when nothing valid is found, so the UI
 * can show a precise message.
 */
export function parseImportedChats(json: string): Conversation[] {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  let raw: unknown[]
  if (Array.isArray(data)) {
    raw = data
  } else if (data && typeof data === 'object' && Array.isArray((data as { conversations?: unknown[] }).conversations)) {
    raw = (data as { conversations: unknown[] }).conversations
  } else if (data && typeof data === 'object' && Array.isArray((data as { messages?: unknown[] }).messages)) {
    raw = [data] // a single per-chat export
  } else {
    throw new Error('No conversations found in that file. Use an LU chat export (.json).')
  }
  const valid = raw.filter(
    (c): c is Conversation =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as Conversation).id === 'string' &&
      typeof (c as Conversation).title === 'string' &&
      Array.isArray((c as Conversation).messages),
  )
  if (valid.length === 0) {
    throw new Error('No valid conversations found in that file.')
  }
  return valid.map((c) => ({ ...c, messages: importedMessages(c.messages as unknown[], c.id) }))
}

const ROLES = new Set(['user', 'assistant', 'system', 'tool'])

/**
 * Every message of an imported chat in the shape the chat view draws.
 *
 * A backup is a file from outside: edited by hand, from an older build, or
 * simply broken. One message with `"content": null` used to be taken as it
 * was, and the chat view fell over on it, again after every restart, while a
 * search in the sidebar took the whole app down (T1 night test 3.0.9, A4).
 * What is not a message at all, or has a role the app does not know, is
 * dropped; a missing id is made up; content that is not text becomes text.
 */
function importedMessages(raw: unknown[], conversationId: string): Message[] {
  const out: Message[] = []
  raw.forEach((m, i) => {
    if (!m || typeof m !== 'object') return
    const msg = m as Record<string, unknown>
    if (typeof msg.role !== 'string' || !ROLES.has(msg.role)) return
    const content = msg.content
    out.push({
      ...(msg as unknown as Message),
      id: typeof msg.id === 'string' && msg.id ? msg.id : `${conversationId}-import-${i}`,
      content: typeof content === 'string' ? content : content == null ? '' : typeof content === 'object' ? JSON.stringify(content) : String(content),
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : 0,
    })
  })
  return out
}

/** References are installation-local. The browser build exports the original
 *  bytes; an image that can no longer be read keeps its reference rather than
 *  costing the user the whole export. */
export async function portableConversation(conversation: Conversation): Promise<Conversation> {
  const messages = []
  for (const message of conversation.messages) {
    if (!message.images?.length) { messages.push(message); continue }
    const images = []
    for (const image of message.images) images.push(await originalAttachment(image).catch(() => image))
    messages.push({ ...message, images })
  }
  return { ...conversation, messages }
}
