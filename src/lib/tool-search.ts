/**
 * Tool search: a small local model sees a short tool list and can still reach
 * every other tool (C59 A2).
 *
 * The selection in tool-selection.ts decides once per step, from the user's
 * words, which tools ride along. On a big catalog a cap has to cut, and a cut
 * tool used to be gone for the run: a model that found out mid-task that it
 * needed `video_generate` or an MCP tool could only say so. OpenClaw's answer
 * (docs.openclaw.ai/tools/tool-search) is a meta tool: the model asks for a
 * capability in its own words, gets the few matching tools back by name, and
 * from the next step on those tools are in its list. RAG-MCP measured what the
 * short list buys: selection accuracy 13.6 % → 43.1 % (arXiv 2505.03275).
 *
 * The search itself is plain word matching over name and description. No
 * embedding call: it has to work on a machine whose embedding model is not
 * there, and the catalog is a few dozen entries.
 *
 * Unlocked tools are kept per conversation for the rest of the run, so the
 * step after the search carries them. `clearUnlockedTools` at the start of a
 * user turn drops them again.
 */
import type { MCPToolDefinition } from '../api/mcp/types'
import { neutralizeToolTags } from '../api/hermes-tool-calling'

export const TOOL_SEARCH = 'tool_search'

/** At most this many tools come back from one search (OpenClaw: 5 for local models). */
export const TOOL_SEARCH_LIMIT = 5

export const TOOL_SEARCH_DEF: MCPToolDefinition = {
  name: TOOL_SEARCH,
  description:
    'Find a tool that is not in your list. Describe what you need in a few words '
    + '(e.g. "make a video", "list running processes"). The matching tools are added to your list for the next step.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the tool should do, a few words' },
    },
    required: ['query'],
  },
  category: 'system',
  source: 'builtin',
}

const unlocked = new Map<string, Set<string>>()

export function unlockedTools(convId: string | null | undefined): ReadonlySet<string> {
  return (convId && unlocked.get(convId)) || new Set()
}

export function unlockTools(convId: string | null | undefined, names: string[]): void {
  if (!convId || !names.length) return
  const set = unlocked.get(convId) ?? new Set<string>()
  for (const n of names) set.add(n)
  unlocked.set(convId, set)
}

export function clearUnlockedTools(convId: string | null | undefined): void {
  if (convId) unlocked.delete(convId)
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'from', 'tool', 'tools', 'my', 'me', 'i', 'it', 'is', 'that', 'this'])

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_\-./]/g, ' ')
    .split(/[^a-z0-9äöüß]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
}

/** Two words match when one starts with the other (generate ~ generation, list ~ listing). */
function close(a: string, b: string): boolean {
  if (a === b) return true
  const n = Math.min(a.length, b.length)
  return n >= 4 && (a.startsWith(b.slice(0, Math.max(4, n - 2))) || b.startsWith(a.slice(0, Math.max(4, n - 2))))
}

interface Scored { t: MCPToolDefinition; score: number }

function scoreTools(query: string, catalog: readonly MCPToolDefinition[]): Scored[] {
  const q = words(query)
  if (!q.length) return []
  return catalog
    .filter((t) => t.name !== TOOL_SEARCH)
    .map((t) => {
      const name = words(t.name)
      // The one-line brief counts too: it names jobs ("rename", "move") the
      // long description only shows as commands, and a 9B searches by job.
      const desc = words(`${t.description} ${CORE_BRIEFS[t.name] ?? ''}`)
      let score = 0
      for (const w of q) {
        if (name.some((n) => close(n, w))) score += 3
        else if (desc.some((d) => close(d, w))) score += 1
      }
      return { t, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
}

/**
 * The tools of `catalog` that fit `query`, best first. A word in the name
 * counts three times as much as one in the description, and a hit has to
 * score more than half of the best one, so "make a video" does not bring
 * image_generate along on the word "make".
 */
export function searchTools(query: string, catalog: readonly MCPToolDefinition[], limit = TOOL_SEARCH_LIMIT): MCPToolDefinition[] {
  const scored = scoreTools(query, catalog)
  if (!scored.length) return []
  const floor = scored[0].score / 2
  return scored.filter((s) => s.score > floor).slice(0, limit).map((s) => s.t)
}

/**
 * One line per core tool for the compact profile. The first sentence of the
 * full description is not enough for these: shell_execute's is "THE
 * terminal.", file_read's drops the paging, todo_write's drops the rule that
 * makes it cheap. Every other tool gets its first sentence (`briefDescription`).
 */
export const CORE_BRIEFS: Readonly<Record<string, string>> = {
  todo_write: 'The task plan the user sees. Send the COMPLETE list each time, together with your next real tool call, never on its own.',
  web_search: 'Search the web: titles, URLs and short snippets. Read the best page with web_fetch before you answer.',
  web_fetch: 'Read one web page (full URL) as text.',
  // P-L (C53) builds web_research for 3.1.0; the line is ready when it lands.
  web_research: 'Search the web and read the best pages in one call; cite sources as [n].',
  file_read: 'Read a text file (path relative to the workspace). For a big file pass offset and limit.',
  file_write: 'Create a file or replace a WHOLE file. To change part of a file use file_edit.',
  file_edit: 'Change part of a file: replace old_string (copied exactly from file_read, unique) with new_string.',
  file_list: 'List a folder ("." is the workspace). recursive and pattern ("*.md") are optional.',
  file_search: 'Search file contents with a regex across a folder: file, line number and text of each match.',
  shell_execute: 'Run one shell command in the workspace: git, tests, scripts, and to rename, move, copy or delete files (mv, cp, mkdir). Returns stdout, stderr, exit code.',
}

/**
 * The line a compact run shows for a tool: ours for the core tools, then the
 * tool's own `brief` (C60 adds the field to MCPToolDefinition), then the
 * first sentence. An external MCP server wrote its own description, so that
 * text is foreign: tool tags are neutralised and it stays on one line, the
 * same treatment the Hermes prompt gives it.
 */
export function briefFor(tool: { name: string; description: string; brief?: string; source?: string }): string {
  const own = CORE_BRIEFS[tool.name]
  if (own) return own
  const line = briefDescription(typeof tool.brief === 'string' && tool.brief.trim() ? tool.brief : tool.description)
  return tool.source === 'external' ? neutralizeToolTags(line) : line
}

/** The first sentence of a description, at most `max` characters. */
export function briefDescription(description: string, max = 160): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  const first = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`
}

/**
 * Runs one search for a conversation and returns what the model reads.
 * `catalog` is everything this run may use (permissions applied), `offered`
 * the names already in the model's list.
 */
export function runToolSearch(
  convId: string | null | undefined,
  args: Record<string, unknown>,
  catalog: readonly MCPToolDefinition[],
  offered: ReadonlySet<string>,
): string {
  const query = typeof args.query === 'string' ? args.query : ''
  if (!query.trim()) return 'tool_search needs a `query`: describe in a few words what the tool should do.'
  const scored = scoreTools(query, catalog)
  if (!scored.length) return `No tool fits "${query}". Carry on with the tools you have, or tell the user what is missing.`
  // The best fit is already offered: say so instead of unlocking a weaker one.
  if (offered.has(scored[0].t.name)) {
    const there = scored.filter((s) => offered.has(s.t.name) && s.score === scored[0].score).map((s) => s.t.name)
    return `No other tool fits "${query}" better. Already in your list: ${there.join(', ')}. Use it.`
  }
  const floor = scored[0].score / 2
  const hits = scored.filter((s) => !offered.has(s.t.name) && s.score > floor).slice(0, TOOL_SEARCH_LIMIT).map((s) => s.t)
  unlockTools(convId, hits.map((t) => t.name))
  return `Added to your tool list for the next step:\n${hits.map((t) => `- ${t.name}: ${briefFor(t)}`).join('\n')}\nCall the one you need in your next step.`
}

/**
 * The tool list for one step of a run with a short list: the selection, plus
 * what this run unlocked, plus `tool_search` itself when the catalog holds
 * anything the list does not.
 */
export function withToolSearch<T extends { name: string }>(
  selected: T[],
  catalog: readonly T[],
  convId: string | null | undefined,
  searchDef: T,
): T[] {
  const have = new Set(selected.map((t) => t.name))
  const open = unlockedTools(convId)
  const extra = catalog.filter((t) => open.has(t.name) && !have.has(t.name))
  const list = [...selected, ...extra]
  const names = new Set(list.map((t) => t.name))
  const somethingLeft = catalog.some((t) => !names.has(t.name) && t.name !== TOOL_SEARCH)
  return somethingLeft && !names.has(TOOL_SEARCH) ? [...list, searchDef] : list
}
