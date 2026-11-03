// The web search of the chat and the agent (3.0.8): which services Settings
// offers, and the text the model reads after a search.
//
// The search runs in the app on the user's computer, also when the chat runs
// on LU Cloud: the cloud model asks for `web_search`, and `executeWebSearch`
// in api/mcp/builtin-tools.ts runs it through the Rust command
// (src-tauri/src/commands/search_tiers.rs). No server is involved.

import type { SearchProvider } from '../types/settings'
import type { WebSearchResult, WebSearchTry } from '../types/bridge'

export interface SearchProviderOption {
  id: SearchProvider
  /** On the button. Short. */
  label: string
  /** One line under the buttons while it is chosen. */
  hint: string
}

/** In the order Auto asks them; the keyed services last. */
export const SEARCH_PROVIDERS: readonly SearchProviderOption[] = [
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Tries Exa, You.com, SearXNG (when it runs), DuckDuckGo and Wikipedia in turn until one answers. A key below goes first.',
  },
  { id: 'exa', label: 'Exa', hint: 'Exa first, free without a key. Auto takes over when it fails.' },
  { id: 'you', label: 'You.com', hint: 'You.com first, free. Auto takes over when it fails.' },
  { id: 'searxng', label: 'SearXNG', hint: 'Your own SearXNG on localhost:8888 first. Auto takes over when it fails.' },
  { id: 'duckduckgo', label: 'DuckDuckGo', hint: 'DuckDuckGo first. It often blocks apps with a bot check; Auto takes over then.' },
  { id: 'wikipedia', label: 'Wikipedia', hint: 'Wikipedia articles only, then Auto when nothing fits.' },
  { id: 'keenable', label: 'Keenable', hint: 'Keenable first, free without a key. Auto takes over when it fails.' },
  { id: 'brave', label: 'Brave', hint: 'Brave Search first. Needs your Brave key below.' },
  { id: 'tavily', label: 'Tavily', hint: 'Tavily first. Needs your Tavily key below.' },
]

const TIER_NAMES: Record<string, string> = {
  exa: 'Exa',
  you: 'You.com',
  searxng: 'SearXNG',
  duckduckgo: 'DuckDuckGo',
  wikipedia: 'Wikipedia',
  brave: 'Brave',
  tavily: 'Tavily',
  keenable: 'Keenable',
}

export function searchProviderLabel(id: string | undefined): string {
  return SEARCH_PROVIDERS.find((p) => p.id === id)?.label ?? TIER_NAMES[id ?? ''] ?? 'Auto'
}

/** A stored value this build does not know (an older or newer store) is Auto. */
export function normalizeSearchProvider(id: string | undefined): SearchProvider {
  return SEARCH_PROVIDERS.some((p) => p.id === id) ? (id as SearchProvider) : 'auto'
}

/** Word for word the sentence of `search_tiers::UNAVAILABLE`. */
export const WEB_SEARCH_UNAVAILABLE =
  'Web search is unavailable right now. Do not repeat the same search. Answer from what you know and say that you could not search.'

/** `Exa: HTTP 429 (rate limit); DuckDuckGo: bot check (HTTP 202)` */
export function triedLine(tried: WebSearchTry[] | undefined): string {
  if (!Array.isArray(tried) || tried.length === 0) return ''
  return tried
    .filter((t) => t.outcome !== 'results')
    .map((t) => {
      const name = TIER_NAMES[t.tier] ?? t.tier
      if (t.outcome === 'empty') return `${name}: nothing found`
      if (t.outcome === 'skipped') return `${name}: not asked, out of time`
      return `${name}: ${t.detail || 'failed'}`
    })
    .join('; ')
}

/**
 * What the model reads after `web_search`. A failure starts with `Error:`, as
 * every tool failure here does (lib/tool-result-failure.ts), so a workflow step
 * and the step list see it as one.
 *
 * No limit on how often the model may search: long research needs many
 * searches. Only when no tier could be asked at all does the text tell the
 * model to stop searching and answer from what it knows.
 */
export function webSearchResultText(data: WebSearchResult, query: string): string {
  if (Array.isArray(data.results) && data.results.length > 0) {
    const lines = data.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n')
    // A configured service that did not answer is named, so a bad key does
    // not look like "search is broken".
    const note = typeof data.providerError === 'string' && data.providerError
      ? `\n\n[Note: the chosen search service did not answer (${data.providerError}). Results above are from ${searchProviderLabel(data.provider)}.]`
      : ''
    return lines + note
  }
  if (data.noResults) {
    return `No results for "${query}". Try other words or a broader query, or answer from what you know.`
  }
  if (data.unavailable || (typeof data.error === 'string' && data.error)) {
    const sentence = data.unavailable ? WEB_SEARCH_UNAVAILABLE : `Web search failed: ${data.error}`
    const tried = triedLine(data.tried)
    return `Error: ${sentence}${tried ? `\n[Tried: ${tried}]` : ''}`
  }
  return JSON.stringify(data)
}
