/**
 * The `memory` tool (C59 A6): the agent writes to LU's existing memory
 * (stores/memoryStore.ts), the same entries the automatic extraction writes
 * and Settings → Memory shows. No new files, no second store.
 *
 * Why a tool next to the extraction: the extraction guesses after the turn;
 * "remember that I write commits in English" is an order the agent should
 * carry out in the turn, and say so. Hermes and OpenClaw both give the model
 * this tool for the same reason.
 *
 * Guard rails:
 * - Secrets are never stored: content that looks like a key or token is
 *   refused (an API key in memory goes into every later prompt).
 * - Size: one entry is at most 600 characters; memory is for durable
 *   facts, not documents.
 * - Every write shows in the run (agent loops, memoryNotice), so the user
 *   sees what was kept and can remove it in Settings → Memory.
 * - Memory comes back into prompts as reference data, never as instructions
 *   (memory injection, unchanged).
 */
import type { MCPToolDefinition } from '../api/mcp/types'
import type { MemoryFile, MemoryType } from '../types/agent-mode'

export const MEMORY_TOOL = 'memory'
export const MEMORY_ENTRY_MAX = 600

export const MEMORY_TOOL_DEF: MCPToolDefinition = {
  name: MEMORY_TOOL,
  description: 'Long-term memory across chats. add: keep a durable fact (a preference, a project fact, a correction); replace / remove: by id; search: find entries. One fact per entry, never secrets.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'replace', 'remove', 'search'], description: 'What to do.' },
      content: { type: 'string', description: 'add / replace: the fact.' },
      type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'add: what the fact is about.' },
      id: { type: 'string', description: 'replace / remove: id from search.' },
      query: { type: 'string', description: 'search: a few words.' },
    },
    required: ['action'],
  },
  category: 'system',
  source: 'builtin',
}

/** Shapes of keys and tokens. A fact like "my key is in 1Password" passes. */
const SECRET_SHAPES: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/, /\bhf_[A-Za-z0-9]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(password|passwort|kennwort|pin|api[ _-]?key|token|secret)\b\s*[:=]\s*\S{6,}/i,
]

export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text))
}

/** What the tool needs from the memory store; the store itself in the app. */
export interface MemoryPort {
  entries: () => MemoryFile[]
  add: (m: Omit<MemoryFile, 'id' | 'createdAt' | 'updatedAt'>) => string
  update: (id: string, u: Partial<Pick<MemoryFile, 'title' | 'description' | 'content' | 'type'>>) => void
  remove: (id: string) => boolean
  search: (query: string, limit: number) => MemoryFile[]
}

const TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

function titleOf(content: string): string {
  const first = content.split(/(?<=[.!?])\s/)[0] ?? content
  return first.length > 60 ? `${first.slice(0, 57)}…` : first
}

const line = (m: MemoryFile) => `- [${m.id}] (${m.type}) ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`

export interface MemoryToolResult { text: string; notice?: string }

export function runMemoryTool(args: Record<string, unknown>, port: MemoryPort, ctx: { convId?: string; scope?: string } = {}): MemoryToolResult {
  const action = String(args.action ?? '').trim()
  const content = typeof args.content === 'string' ? args.content.trim() : ''
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (action === 'search') {
    const q = typeof args.query === 'string' ? args.query : content
    const hits = q.trim() ? port.search(q, 8) : port.entries().filter((m) => !m.sensitive).slice(-8)
    return { text: hits.length ? hits.filter((m) => !m.sensitive).map(line).join('\n') : 'No memory entry matches.' }
  }
  if (action === 'remove') {
    if (!id) return { text: 'Error: remove needs the `id` of an entry (find it with action "search").' }
    const target = port.entries().find((m) => m.id === id)
    if (!target) return { text: `Error: no memory entry with id ${id}.` }
    port.remove(id)
    return { text: `Removed memory entry ${id}.`, notice: `🧠 Removed from memory: ${titleOf(target.content)}` }
  }
  if (action !== 'add' && action !== 'replace') return { text: 'Error: action must be add, replace, remove or search.' }
  if (!content) return { text: `Error: ${action} needs \`content\`.` }
  if (looksLikeSecret(content)) {
    return { text: 'Error: Refused: this looks like a password, key or token. LU never keeps secrets in memory, because memory goes into later prompts. Nothing was saved.' }
  }
  if (content.length > MEMORY_ENTRY_MAX) return { text: `Error: an entry is at most ${MEMORY_ENTRY_MAX} characters. Keep the durable fact, not the whole text.` }
  if (action === 'replace') {
    if (!id) return { text: 'Error: replace needs the `id` of an entry (find it with action "search").' }
    if (!port.entries().some((m) => m.id === id)) return { text: `Error: no memory entry with id ${id}.` }
    port.update(id, { content, title: titleOf(content), description: content.slice(0, 120) })
    return { text: `Updated memory entry ${id}.`, notice: `🧠 Memory updated: ${titleOf(content)}` }
  }
  const same = port.entries().find((m) => m.content.trim().toLowerCase() === content.toLowerCase())
  if (same) return { text: `Already remembered as ${same.id}.` }
  const type = TYPES.includes(args.type as MemoryType) ? (args.type as MemoryType) : 'user'
  const newId = port.add({
    type, title: titleOf(content), description: content.slice(0, 120), content, tags: ['agent'],
    source: ctx.convId ?? 'agent:memory-tool', ...(ctx.scope ? { scope: ctx.scope } : {}),
  })
  return { text: `Remembered as ${newId}. It reaches later conversations by itself.`, notice: `🧠 Saved to memory: ${titleOf(content)}` }
}
