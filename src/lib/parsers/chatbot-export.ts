// Feature CC v2.5.0 — Chatbot export importer (MikeS++ Discord 2026-05-27).
// Parses ChatGPT / Claude / Gemini conversation exports and produces a
// normalised list of `{title, markdown}` items the rest of the importer can
// feed into the RAG pipeline as if they were ordinary text uploads.
//
// We accept either a raw JSON file (the user already unzipped the export)
// or a .zip (we walk it for conversations.json). The parsers are loose by
// design: each platform's export schema has churned multiple times, and
// failing to import a conversation is much better than crashing the whole
// import run. Unrecognised entries are skipped and counted in the result
// so the UI can surface a "skipped N items" hint.

import JSZip from 'jszip'
import { isRecord, prop, asString, asNumber, asIdString } from '../../types/json-guards'

export type ChatbotPlatform = 'chatgpt' | 'claude' | 'gemini' | 'unknown'

export interface NormalisedConversation {
  /** Stable id for the import list (filename-safe). */
  id: string
  /** Human-readable title (falls back to "Untitled <date>"). */
  title: string
  /** Final markdown a RAG processor will consume. */
  markdown: string
  /** Best-guess platform — surfaced as the document's source field. */
  platform: ChatbotPlatform
  /** ISO timestamp of the conversation (creation or last update). */
  timestamp: string | null
  /** Message count, for the UI. */
  messageCount: number
}

export interface ParseResult {
  conversations: NormalisedConversation[]
  /** Number of items in the raw export we couldn't map to a conversation. */
  skipped: number
  /** Detected platform across the export (heuristic). */
  detectedPlatform: ChatbotPlatform
}

/** Read a File object as text. */
async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsText(file)
  })
}

/** Detect platform from the parsed JSON shape. */
export function detectPlatform(parsed: unknown): ChatbotPlatform {
  if (!parsed) return 'unknown'
  if (Array.isArray(parsed) && parsed.length > 0) {
    const sample: unknown = parsed[0]
    // ChatGPT exports use `mapping` (id → message node).
    if (isRecord(sample) && 'mapping' in sample) return 'chatgpt'
    // Claude uses `chat_messages` (array of { sender, text }).
    if (isRecord(sample) && 'chat_messages' in sample) return 'claude'
    // Gemini Takeout activity exports use `title` + `messages` and `header` = "Gemini Apps"
    if (isRecord(sample) && 'header' in sample && (asString(sample.header) ?? '').toLowerCase().includes('gemini')) return 'gemini'
  }
  // Some Gemini bundles use a wrapper { activities: [...] }.
  if (isRecord(parsed) && 'activities' in parsed) return 'gemini'
  return 'unknown'
}

/** Sanitise a string for use as a filename / id. */
function slugify(s: string, fallback: string): string {
  const cleaned = (s || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  return cleaned || fallback
}

// ── ChatGPT ────────────────────────────────────────────────────────────
// Schema (verified against OpenAI Data Export Aug 2024 + Apr 2026):
//   [
//     {
//       "title": "...",
//       "create_time": 1700000000.0,
//       "update_time": 1700001000.0,
//       "mapping": {
//         "<uuid>": {
//           "id": "<uuid>",
//           "message": null | {
//             "id": "...",
//             "author": { "role": "system" | "user" | "assistant" | "tool", ... },
//             "create_time": 1700000000.0,
//             "content": { "content_type": "text", "parts": ["..."] }
//           },
//           "parent": "<uuid>" | null,
//           "children": ["<uuid>", ...]
//         }
//       }
//     }
//   ]
// Pull readable text out of a ChatGPT message `content` object. Real exports
// use several content_type shapes:
//   { content_type: 'text', parts: ['...'] }
//   { content_type: 'multimodal_text', parts: ['...', { content_type:'image_asset_pointer', ... }] }
//   { content_type: 'code' | 'execution_output', text: '...' }
//   { content_type: 'tether_*' , result: '...' }
// Strings in `parts` are kept; non-text parts (image/audio pointers) are
// skipped gracefully; falls back to `content.text` / `content.result`.
function extractChatGptText(content: unknown): string {
  if (!isRecord(content)) return ''
  const chunks: string[] = []
  const parts = content.parts
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (typeof p === 'string') { if (p.trim()) chunks.push(p) }
      else {
        const t = asString(prop(p, 'text'))
        if (t && t.trim()) chunks.push(t)
      }
      // image_asset_pointer / audio_asset_pointer / etc. carry no readable text → skip
    }
  }
  const flat = asString(content.text)
  if (chunks.length === 0 && flat && flat.trim()) chunks.push(flat)
  const result = asString(content.result)
  if (chunks.length === 0 && result && result.trim()) chunks.push(result)
  return chunks.join('\n').trim()
}

/**
 * One node of a ChatGPT export's `mapping`. Only what the linearisation needs
 * is lifted out; `message` stays `unknown` because extractChatGptText does its
 * own checking on it.
 */
interface ChatGptNode {
  id: string
  message: unknown
  /** Parent node id, or undefined for a root. */
  parent: string | undefined
  /** Child node ids, in export order (oldest → newest branch). */
  children: string[]
}

/**
 * Accept a mapping entry only if it carries an id — the walks below key their
 * cycle guard on it, and a node without one cannot be found again anyway.
 * Ids are normalised through asIdString because a re-serialised export can
 * write them as numbers (the pre-guard code relied on JS key coercion for
 * exactly that case).
 */
function asChatGptNode(v: unknown): ChatGptNode | undefined {
  if (!isRecord(v)) return undefined
  const id = asIdString(v.id)
  if (!id) return undefined
  const children = Array.isArray(v.children)
    ? v.children.map(asIdString).filter((c): c is string => c !== undefined)
    : []
  return { id, message: v.message, parent: asIdString(v.parent), children }
}

// Turn an ordered list of mapping nodes (root → leaf) into markdown lines.
function linearizeChatGptNodes(nodes: ChatGptNode[]): { lines: string[]; count: number } {
  const lines: string[] = []
  let count = 0
  for (const node of nodes) {
    const msg = node.message
    if (!isRecord(msg)) continue
    const author = msg.author
    if (!isRecord(author) || msg.content == null) continue
    const role = asString(author.role) || 'unknown'
    const text = extractChatGptText(msg.content)
    if (text && role !== 'tool' && role !== 'system') {
      const heading = role === 'user' ? '**You**' : (role === 'assistant' ? '**Assistant**' : `**${role}**`)
      lines.push(heading, '', text, '')
      count++
    }
  }
  return { lines, count }
}

function parseChatGpt(raw: unknown): NormalisedConversation[] {
  if (!Array.isArray(raw)) return []
  const out: NormalisedConversation[] = []
  for (const conv of raw) {
    if (!isRecord(conv)) continue
    const c = conv
    const title = (asString(c.title) || '').trim() || 'Untitled ChatGPT conversation'
    const createTime = asNumber(c.create_time) ?? null
    const updateTime = asNumber(c.update_time) ?? null
    const timestamp = updateTime ?? createTime
    const isoTimestamp = timestamp ? new Date(timestamp * 1000).toISOString() : null

    const mapping = c.mapping
    if (!isRecord(mapping)) continue
    const nodeAt = (id: string): ChatGptNode | undefined => asChatGptNode(mapping[id])

    // Linearise the message tree into the single thread the user actually saw.
    // Real exports have a synthetic root (message == null) and, after edits or
    // regenerations, multiple sibling branches — the old "first node with
    // parent==null, then children[0] forever" walk lands on the ORIGINAL
    // (often abandoned) branch and frequently dead-ends at 0 messages, which
    // is why mikes_pp's import produced "no conversations". Two strategies,
    // best first:
    //   1. `current_node` is the leaf of the visible thread — walk PARENT
    //      links up to the root and reverse. Exactly what the user saw.
    //   2. Fallback: from each parent-less node walk forward following the
    //      LAST (newest) child; keep whichever walk yields the most messages.
    const collectUp = (leafId: string): ChatGptNode[] => {
      const chain: ChatGptNode[] = []
      const seen = new Set<string>()
      let node = nodeAt(leafId)
      while (node && !seen.has(node.id)) {
        seen.add(node.id)
        chain.push(node)
        node = node.parent !== undefined ? nodeAt(node.parent) : undefined
      }
      chain.reverse()
      return chain
    }
    const collectDown = (rootId: string): ChatGptNode[] => {
      const chain: ChatGptNode[] = []
      const seen = new Set<string>()
      let node = nodeAt(rootId)
      while (node && !seen.has(node.id)) {
        seen.add(node.id)
        chain.push(node)
        const nextId = node.children.length > 0 ? node.children[node.children.length - 1] : undefined
        node = nextId !== undefined ? nodeAt(nextId) : undefined
      }
      return chain
    }

    let best: { lines: string[]; count: number } | null = null
    const currentNodeId = asIdString(c.current_node)
    if (currentNodeId && nodeAt(currentNodeId)) {
      best = linearizeChatGptNodes(collectUp(currentNodeId))
    }
    if (!best || best.count === 0) {
      const rootIds = Object.values(mapping)
        .map(asChatGptNode)
        .filter((n): n is ChatGptNode => n !== undefined && n.parent === undefined)
        .map((n) => n.id)
      const candidates = rootIds.length > 0 ? rootIds : Object.keys(mapping)
      for (const rid of candidates) {
        const r = linearizeChatGptNodes(collectDown(rid))
        if (!best || r.count > best.count) best = r
      }
    }
    if (!best || best.count === 0) continue

    const lines: string[] = [`# ${title}`, '']
    if (isoTimestamp) lines.push(`_Created: ${isoTimestamp}_`, '')
    lines.push(...best.lines)
    out.push({
      id: slugify(title, `chatgpt_${createTime || out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'chatgpt',
      timestamp: isoTimestamp,
      messageCount: best.count,
    })
  }
  return out
}

// ── Claude ─────────────────────────────────────────────────────────────
// Schema (verified against Anthropic export Apr 2026):
//   [
//     {
//       "uuid": "...",
//       "name": "...",
//       "created_at": "2026-01-01T...",
//       "updated_at": "...",
//       "chat_messages": [
//         {
//           "uuid": "...",
//           "text": "...",                                  // legacy flat copy, often "" in modern exports
//           "content": [{ "type": "text", "text": "..." }], // modern message body (preferred)
//           "sender": "human" | "assistant",
//           "attachments": [{ "file_name": "...", "extracted_content": "..." }],
//           "created_at": "..."
//         }
//       ]
//     }
//   ]
// Modern Claude exports carry the message body in a typed `content[]` block
// array ([{ type:'text', text:'…' }, { type:'tool_use', … }]) and frequently
// leave the flat `text` field EMPTY — so the old `m.text`-only read imported
// those conversations as 0 messages and dropped them entirely (aldrich,
// Discord 2026-06-20 "how do i import chats from claude"). Prefer the text
// blocks, fall back to the flat field, and append any extracted attachment
// text (mikes_pp also asked for uploaded-file content). Non-text blocks
// (tool_use / tool_result / thinking) carry no `text` string and are skipped.
function extractClaudeText(m: unknown): string {
  const chunks: string[] = []
  const content = prop(m, 'content')
  if (Array.isArray(content)) {
    for (const blk of content) {
      const t = asString(prop(blk, 'text'))
      if (t && t.trim()) chunks.push(t.trim())
    }
  }
  const flat = asString(prop(m, 'text'))
  if (chunks.length === 0 && flat && flat.trim()) {
    chunks.push(flat.trim())
  }
  // Pasted / uploaded file contents Claude extracted at chat time.
  const attachments = prop(m, 'attachments')
  for (const a of Array.isArray(attachments) ? attachments : []) {
    const extracted = (asString(prop(a, 'extracted_content')) ?? '').trim()
    if (extracted) {
      const name = asString(prop(a, 'file_name'))
      const fname = name ? `[attachment: ${name}]\n` : ''
      chunks.push(fname + extracted)
    }
  }
  return chunks.join('\n\n').trim()
}

function parseClaude(raw: unknown): NormalisedConversation[] {
  if (!Array.isArray(raw)) return []
  const out: NormalisedConversation[] = []
  for (const conv of raw) {
    if (!isRecord(conv)) continue
    const c = conv
    const title = (asString(c.name) || '').trim() || 'Untitled Claude conversation'
    const isoTimestamp = asString(c.updated_at) ?? asString(c.created_at) ?? null
    const messages = Array.isArray(c.chat_messages) ? c.chat_messages : []
    if (messages.length === 0) continue
    const lines: string[] = [`# ${title}`, '']
    if (isoTimestamp) lines.push(`_Created: ${isoTimestamp}_`, '')
    let messageCount = 0
    for (const m of messages) {
      const sender = asString(prop(m, 'sender')) || 'unknown'
      const text = extractClaudeText(m)
      if (!text) continue
      const heading = sender === 'human' ? '**You**' : (sender === 'assistant' ? '**Assistant**' : `**${sender}**`)
      lines.push(heading, '', text, '')
      messageCount++
    }
    if (messageCount === 0) continue
    out.push({
      id: slugify(title, `claude_${asIdString(c.uuid) ?? out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'claude',
      timestamp: isoTimestamp,
      messageCount,
    })
  }
  return out
}

// ── Gemini ─────────────────────────────────────────────────────────────
// Gemini exports come via Google Takeout. There are several shapes; the most
// common one is an activity-stream JSON where each entry is a Search-style
// `{ title, time, header: "Gemini Apps" }` with an inline transcript. We
// parse defensively — anything we can't extract becomes a single-message
// markdown entry that still carries the prompt text.
/**
 * Readable text of one Gemini activity message.
 *
 * `content` is a string in the flat activity shape and a BLOCK ARRAY
 * ([{ text: '…' }, …]) in the shape Takeout produces for Gemini API-style
 * turns. The old `String(m.text || m.content || '')` stringified that array
 * into `[object Object]` and imported it verbatim as the message body — the
 * conversation the user asked for was replaced by that literal, one line per
 * turn, and the real text was gone. Strings are taken as-is, block arrays are
 * flattened, and anything else contributes nothing.
 */
function extractGeminiText(m: unknown): string {
  const flat = asString(prop(m, 'text'))
  if (flat && flat.trim()) return flat.trim()
  const content = prop(m, 'content')
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const chunks: string[] = []
    for (const blk of content) {
      if (typeof blk === 'string') { if (blk.trim()) chunks.push(blk.trim()); continue }
      const t = asString(prop(blk, 'text'))
      if (t && t.trim()) chunks.push(t.trim())
    }
    return chunks.join('\n').trim()
  }
  return ''
}

function parseGemini(raw: unknown): NormalisedConversation[] {
  let items: unknown[] = []
  if (Array.isArray(raw)) items = raw
  else {
    const activities = prop(raw, 'activities')
    if (Array.isArray(activities)) items = activities
  }
  const out: NormalisedConversation[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const i = item
    const header = (asString(i.header) ?? '').toLowerCase()
    if (!header.includes('gemini') && !header.includes('bard')) continue
    const title = (asString(i.title) ?? '').trim().slice(0, 120) || 'Gemini activity'
    const timestamp = asString(i.time) ?? null
    const messages = Array.isArray(i.messages) ? i.messages : []
    const lines: string[] = [`# ${title}`, '']
    if (timestamp) lines.push(`_When: ${timestamp}_`, '')
    let messageCount = 0
    if (messages.length > 0) {
      for (const m of messages) {
        const role = asString(prop(m, 'role')) ?? asString(prop(m, 'author')) ?? 'unknown'
        const text = extractGeminiText(m)
        if (!text) continue
        const heading = (role === 'user' || role === 'human') ? '**You**' : '**Assistant**'
        lines.push(heading, '', text, '')
        messageCount++
      }
    } else {
      // Single-prompt activity entry. Surface the title + body as one Q.
      lines.push('**You**', '', title, '')
      messageCount = 1
    }
    if (messageCount === 0) continue
    out.push({
      id: slugify(title, `gemini_${out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'gemini',
      timestamp,
      messageCount,
    })
  }
  return out
}

/** Parse a single JSON blob (already-decoded string). */
export function parseJsonText(text: string): ParseResult {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    return { conversations: [], skipped: 0, detectedPlatform: 'unknown' }
  }
  const detected = detectPlatform(parsed)
  let convs: NormalisedConversation[] = []
  switch (detected) {
    case 'chatgpt': convs = parseChatGpt(parsed); break
    case 'claude': convs = parseClaude(parsed); break
    case 'gemini': convs = parseGemini(parsed); break
    default: {
      // Last-ditch: try them all, return whichever produced the most output.
      const tries: Array<[ChatbotPlatform, NormalisedConversation[]]> = [
        ['chatgpt', parseChatGpt(parsed)],
        ['claude', parseClaude(parsed)],
        ['gemini', parseGemini(parsed)],
      ]
      tries.sort((a, b) => b[1].length - a[1].length)
      convs = tries[0][1]
      if (convs.length === 0) return { conversations: [], skipped: 1, detectedPlatform: 'unknown' }
      break
    }
  }
  const rawLen = Array.isArray(parsed) ? parsed.length : 1
  const skipped = Math.max(0, rawLen - convs.length)
  return { conversations: convs, skipped, detectedPlatform: convs[0]?.platform || detected }
}

/** Parse a user-provided File (either .json or a .zip that contains conversations.json). */
export async function parseExportFile(file: File): Promise<ParseResult> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file)
    // Collect every file entry. Depth-independent on purpose: current ChatGPT
    // exports nest everything under a dated top-level folder, e.g.
    // "1716800000-ab12cd…/conversations.json", so the old exact-path lookup of
    // "conversations.json" / "data/conversations.json" missed entirely and the
    // user saw "no conversation file found" (mikes_pp, Discord 2026-06-07).
    const entries: Array<{ path: string; entry: JSZip.JSZipObject }> = []
    zip.forEach((path, entry) => { if (!entry.dir) entries.push({ path, entry }) })
    // Split on BOTH separators. Standard zips use '/', but Windows tools
    // (Explorer "Send to > Compressed folder", PowerShell Compress-Archive)
    // emit BACKSLASH-separated entry names. Without this a Windows-rezipped
    // export fails the conversations-NNN.json match, drops to the parse-and-pick
    // fallback, and only ONE shard (~100 chats) imports (verified 2026-06-21
    // with a 10-shard 1000-chat zip).
    const basename = (p: string) => (p.split(/[\\/]/).pop() || '').toLowerCase()
    const isJson = (p: string) => p.toLowerCase().endsWith('.json')

    // 1) Conversations live in one or more files named conversations.json or,
    //    for large exports, sharded as conversations-000.json,
    //    conversations-001.json, … (ChatGPT splits at ~100 chats per shard).
    //    Parse EVERY such file and MERGE them, wherever they sit in the tree
    //    (handles the dated-folder nesting). mikes_pp, Discord 2026-06-17:
    //    only the first 100 chats imported because we returned on the first
    //    file and conversations-001.json was ignored.
    const isConversationsFile = (p: string) => {
      const b = basename(p)
      return b === 'conversations.json' || /^conversations-\d+\.json$/.test(b)
    }
    const convFiles = entries
      .filter(e => isConversationsFile(e.path))
      // Deterministic shard order: conversations.json, then -000, -001, …
      .sort((a, b) => basename(a.path).localeCompare(basename(b.path), 'en', { numeric: true }))
    if (convFiles.length > 0) {
      const merged: NormalisedConversation[] = []
      let skipped = 0
      let platform: ChatbotPlatform = 'unknown'
      for (const e of convFiles) {
        const text = await e.entry.async('string')
        const res = parseJsonText(text)
        merged.push(...res.conversations)
        skipped += res.skipped
        if (res.detectedPlatform !== 'unknown') platform = res.detectedPlatform
      }
      if (merged.length > 0) {
        return { conversations: merged, skipped, detectedPlatform: platform }
      }
    }
    // 2) Parse-and-pick: try every JSON file and keep whichever produces the
    //    most conversations. We deliberately do NOT rank by file size via
    //    JSZip's private `_data.uncompressedSize` — it is 0/undefined for many
    //    entries, which previously made the fallback grab user.json /
    //    message_feedback.json (→ 0 conversations) instead of the real export.
    let best: ParseResult | null = null
    for (const e of entries.filter(e => isJson(e.path))) {
      const text = await e.entry.async('string')
      const res = parseJsonText(text)
      if (res.conversations.length > 0 && (!best || res.conversations.length > best.conversations.length)) {
        best = res
      }
    }
    if (best) return best
    return { conversations: [], skipped: 0, detectedPlatform: 'unknown' }
  }
  // JSON path
  const text = await readFileAsText(file)
  return parseJsonText(text)
}

/** Convert a normalised conversation into a File the RAG uploader accepts. */
export function conversationToFile(conv: NormalisedConversation): File {
  const filename = `${conv.platform}_${conv.id}.md`
  const blob = new Blob([conv.markdown], { type: 'text/markdown' })
  return new File([blob], filename, { type: 'text/markdown' })
}
