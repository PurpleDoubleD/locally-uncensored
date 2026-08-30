/**
 * Chat Export — Markdown and JSON formats.
 *
 * When running inside Tauri, the user gets a native "Save As…" dialog to
 * pick the destination. In a plain browser context we fall back to a
 * blob-download.
 */

import type { Conversation } from '../types/chat'
import { isTauri, backendCall } from '../api/backend'
import { conversationModelOf } from './conversation-model'

export function exportAsMarkdown(conversation: Conversation): string {
  const lines: string[] = []
  lines.push(`# ${conversation.title}`)
  // The model of the last answer, not the conversation field. That field is
  // rewritten every time the picker moves, so an export could name a model
  // that produced none of the text below it (Meldung 4, R5 re-measure
  // 2026-08-30). Old chats whose answers carry no model fall back to the
  // field, which is all that was ever known about them.
  lines.push(`_Model: ${conversationModelOf(conversation)} | ${new Date(conversation.createdAt).toLocaleString()}_`)
  lines.push('')

  if (conversation.systemPrompt) {
    lines.push('## System Prompt')
    lines.push(conversation.systemPrompt)
    lines.push('')
  }

  lines.push('---')
  lines.push('')

  for (const msg of conversation.messages) {
    const role = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : msg.role
    lines.push(`### ${role}`)

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
    lines.push(msg.content)
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

export function exportAsJSON(conversation: Conversation): string {
  return JSON.stringify(conversation, null, 2)
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
): Promise<{ status: 'saved' | 'cancelled' | 'downloaded'; path?: string; error?: string }> {
  const safeTitle = conversation.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
  const ext = format === 'markdown' ? 'md' : 'json'
  const extLabel = format === 'markdown' ? 'Markdown' : 'JSON'
  const mime = format === 'markdown' ? 'text/markdown' : 'application/json'
  const filename = `${safeTitle}.${ext}`
  const content = format === 'markdown' ? exportAsMarkdown(conversation) : exportAsJSON(conversation)

  // Inside Tauri → native Save As dialog + real disk write
  if (isTauri()) {
    try {
      const chosenPath = await backendCall<string | null>('save_text_file_dialog', {
        content,
        defaultName: filename,
        extension: ext,
        extLabel,
      })
      if (!chosenPath) return { status: 'cancelled' }
      return { status: 'saved', path: chosenPath }
    } catch (e) {
      // Fall through to blob download if the Tauri command fails for any reason
      downloadFile(content, filename, mime)
      return { status: 'downloaded', error: String(e) }
    }
  }

  // Plain browser fallback
  downloadFile(content, filename, mime)
  return { status: 'downloaded' }
}

// ── Bulk backup (konata 2026-06-28: the web build has no store_backup.json,
// so a tunnel/origin change loses chats). Export ALL conversations to one JSON
// file the user can re-import into any LU (web or desktop). ─────────────────

export interface ChatExportBundle {
  app: 'locally-uncensored'
  kind: 'chat-export'
  version: 1
  exportedAt: number
  count: number
  conversations: Conversation[]
}

export function serializeAllConversations(conversations: Conversation[]): string {
  const bundle: ChatExportBundle = {
    app: 'locally-uncensored',
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
): Promise<{ status: 'saved' | 'cancelled' | 'downloaded'; path?: string; count: number; error?: string }> {
  const count = conversations.length
  const content = serializeAllConversations(conversations)
  const filename = `locally-uncensored-chats-${count}.json`

  if (isTauri()) {
    try {
      const chosenPath = await backendCall<string | null>('save_text_file_dialog', {
        content,
        defaultName: filename,
        extension: 'json',
        extLabel: 'JSON',
      })
      if (!chosenPath) return { status: 'cancelled', count }
      return { status: 'saved', path: chosenPath, count }
    } catch (e) {
      downloadFile(content, filename, 'application/json')
      return { status: 'downloaded', count, error: String(e) }
    }
  }

  downloadFile(content, filename, 'application/json')
  return { status: 'downloaded', count }
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
  return valid
}
