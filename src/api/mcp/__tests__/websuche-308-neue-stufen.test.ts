/**
 * 3.0.8: die Websuche nach Jans Vorbild.
 *
 * Auto fragt Exa (MCP, ohne Schluessel), You.com, SearXNG, DuckDuckGo und
 * Wikipedia der Reihe nach (src-tauri/src/commands/search_tiers.rs). Diese
 * Datei nagelt fest, was davon im Frontend liegt: die Stufen unter Settings,
 * der Exa-Schluessel auf dem Weg zum Rust-Befehl, der Text, den das Modell
 * liest, und der eine Satz, wenn wirklich jede Stufe scheitert. Eine Grenze
 * fuer die Zahl der Suchen gibt es nicht und darf es nicht geben.
 *
 * Run: npx vitest run src/api/mcp/__tests__/websuche-308-neue-stufen.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const h = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
const backendCall = vi.fn(async (..._a: unknown[]) => ({}))

vi.mock('../../backend', () => ({
  isTauri: () => true,
  backendCall: (...a: unknown[]) => backendCall(...a),
}))
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: h.settings }) },
}))

import { registerBuiltinTools } from '../builtin-tools'
import { ToolRegistry } from '../tool-registry'
import {
  SEARCH_PROVIDERS,
  WEB_SEARCH_UNAVAILABLE,
  normalizeSearchProvider,
  searchProviderLabel,
  triedLine,
  webSearchResultText,
} from '../../../lib/search-providers'
import { toolResultIsFailure } from '../../../lib/tool-result-failure'
import { explainError } from '../../agents/error-hints'
import { DEFAULT_SETTINGS } from '../../../lib/constants'
import { SETTINGS_TAB_RESET_KEYS } from '../../../lib/settings-reset'
import type { SearchProvider } from '../../../types/settings'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

const root = resolve(__dirname, '../../../..')
const rustTiers = readFileSync(resolve(root, 'src-tauri/src/commands/search_tiers.rs'), 'utf8')
const settingsPage = readFileSync(resolve(root, 'src/components/settings/SettingsPage.tsx'), 'utf8')

const ALL_FAILED = {
  results: [],
  unavailable: true,
  error: WEB_SEARCH_UNAVAILABLE,
  tried: [
    { tier: 'exa', outcome: 'failed', detail: 'HTTP 429 (rate limit)' },
    { tier: 'you', outcome: 'failed', detail: 'timed out' },
    { tier: 'duckduckgo', outcome: 'failed', detail: 'Lite: bot check (HTTP 202); HTML: bot check (HTTP 202)' },
    { tier: 'wikipedia', outcome: 'failed', detail: 'HTTP 403 (refused)' },
  ],
}

beforeEach(() => {
  backendCall.mockReset()
  h.settings = {}
})

describe('der Satz, wenn jede Stufe scheitert', () => {
  it('steht Wort fuer Wort so da, wie David ihn wollte, und gleich wie in Rust', () => {
    expect(WEB_SEARCH_UNAVAILABLE).toBe(
      'Web search is unavailable right now. Do not repeat the same search. Answer from what you know and say that you could not search.',
    )
    expect(rustTiers).toContain(`pub(crate) const UNAVAILABLE: &str = "${WEB_SEARCH_UNAVAILABLE}";`)
  })

  it('das Modell liest ihn als Fehler, mit den Stufen dahinter', async () => {
    backendCall.mockResolvedValue(ALL_FAILED)
    const out = (await registry.execute('web_search', { query: 'tea history' })) as string
    expect(out.startsWith(`Error: ${WEB_SEARCH_UNAVAILABLE}`)).toBe(true)
    expect(out).toContain('[Tried: Exa: HTTP 429 (rate limit); You.com: timed out; DuckDuckGo: Lite: bot check')
    expect(out).toContain('Wikipedia: HTTP 403 (refused)]')
    expect(toolResultIsFailure(out)).toBe(true)
  })

  it('der Hinweis danach laedt nicht zur naechsten Suche ein', () => {
    const out = webSearchResultText(ALL_FAILED as never, 'x')
    const hint = explainError('web_search', out)
    expect(hint).toMatch(/^Do not search again/)
    expect(hint).not.toMatch(/broaden|wait/i)
  })
})

describe('nichts gefunden ist kein Ausfall', () => {
  it('sagt es und bleibt ein Ergebnis', () => {
    const out = webSearchResultText({ results: [], noResults: true, tried: [] }, 'zzqx')
    expect(out).toBe('No results for "zzqx". Try other words or a broader query, or answer from what you know.')
    expect(toolResultIsFailure(out)).toBe(false)
  })

  it('eine Antwort im alten Format bleibt ein Fehler wie bisher', () => {
    expect(webSearchResultText({ error: 'All search tiers failed' }, 'q')).toBe('Error: Web search failed: All search tiers failed')
  })
})

describe('Treffer', () => {
  it('werden als Liste gezeigt, und ein gewaehlter Dienst, der nicht antwortete, wird genannt', () => {
    const out = webSearchResultText(
      {
        results: [{ title: 'Rust', url: 'https://www.rust-lang.org/', snippet: 'A language.' }],
        provider: 'you',
        providerError: 'HTTP 401 (check the API key)',
      },
      'rust',
    )
    expect(out).toContain('1. Rust\n   https://www.rust-lang.org/\n   A language.')
    expect(out).toContain('[Note: the chosen search service did not answer (HTTP 401 (check the API key)). Results above are from You.com.]')
    expect(toolResultIsFailure(out)).toBe(false)
  })

  it('triedLine nennt nur, was nicht geantwortet hat', () => {
    expect(
      triedLine([
        { tier: 'exa', outcome: 'empty' },
        { tier: 'wikipedia', outcome: 'skipped' },
        { tier: 'you', outcome: 'results', count: 3 },
      ]),
    ).toBe('Exa: nothing found; Wikipedia: not asked, out of time')
    expect(triedLine(undefined)).toBe('')
  })
})

describe('keine Grenze fuer die Zahl der Suchen', () => {
  it('die Werkzeugbeschreibung nennt keine Hoechstzahl, nur: nicht dieselbe Suche wiederholen', () => {
    const tool = registry.getAll().find((t) => t.name === 'web_search')!
    expect(tool.description).not.toMatch(/more than \d|at most \d|\d+ (similar )?quer/i)
    expect(tool.description).toContain('never repeat an identical query')
  })

  it('zehn verschiedene Suchen hintereinander gehen alle an den Rust-Befehl', async () => {
    backendCall.mockResolvedValue({ results: [{ title: 't', url: 'https://x.example/', snippet: 's' }], provider: 'exa' })
    for (let i = 0; i < 10; i++) {
      const out = (await registry.execute('web_search', { query: `topic ${i}` })) as string
      expect(out.startsWith('1. t')).toBe(true)
    }
    expect(backendCall).toHaveBeenCalledTimes(10)
  })
})

describe('Settings, Search Provider', () => {
  it('jede Stufe ist waehlbar, kurz benannt, und Rust kennt jede', () => {
    const ids = SEARCH_PROVIDERS.map((p) => p.id)
    const all: SearchProvider[] = ['auto', 'exa', 'you', 'searxng', 'duckduckgo', 'wikipedia', 'keenable', 'brave', 'tavily']
    expect(ids).toEqual(all)
    for (const p of SEARCH_PROVIDERS) {
      expect(p.label.length, p.label).toBeLessThanOrEqual(10)
      expect(p.hint).not.toMatch(/\u2014|\u2013/)
      if (p.id !== 'auto') expect(rustTiers).toContain(`=> "${p.id}",`)
    }
    expect(SEARCH_PROVIDERS.map((p) => p.label)).toEqual(['Auto', 'Exa', 'You.com', 'SearXNG', 'DuckDuckGo', 'Wikipedia', 'Keenable', 'Brave', 'Tavily'])
  })

  it('Auto nennt die Reihenfolge, in der Rust fragt', () => {
    expect(SEARCH_PROVIDERS[0].hint).toMatch(/Exa, You\.com, SearXNG \(when it runs\), DuckDuckGo and Wikipedia/)
    const order = ['out.push(Tier::Exa)', 'out.push(Tier::You)', 'out.push(Tier::Searxng)', 'out.push(Tier::DuckDuckGo)', 'out.push(Tier::Wikipedia)']
    const at = order.map((o) => rustTiers.indexOf(o))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('ein gespeicherter Wert, den dieser Build nicht kennt, ist Auto', () => {
    expect(normalizeSearchProvider('bing')).toBe('auto')
    expect(normalizeSearchProvider(undefined)).toBe('auto')
    expect(normalizeSearchProvider('wikipedia')).toBe('wikipedia')
    expect(searchProviderLabel('duckduckgo')).toBe('DuckDuckGo')
  })

  it('der Exa-Schluessel ist leer voreingestellt, wird mit zurueckgesetzt und bleibt lokal', () => {
    expect(DEFAULT_SETTINGS.exaApiKey).toBe('')
    expect(DEFAULT_SETTINGS.searchProvider).toBe('auto')
    expect(SETTINGS_TAB_RESET_KEYS.agent).toEqual(expect.arrayContaining(['searchProvider', 'braveApiKey', 'tavilyApiKey', 'exaApiKey']))
  })

  it('die Seite zeigt alle Stufen und ein Feld fuer den Exa-Schluessel', () => {
    expect(settingsPage).toContain('SEARCH_PROVIDERS.map(p =>')
    expect(settingsPage).toContain('updateSettings({ searchProvider: p.id })')
    expect(settingsPage).toContain('id="search-exa-key"')
    expect(settingsPage).toContain('updateSettings({ exaApiKey: e.target.value })')
    expect(settingsPage).toContain('type="password"')
    expect(settingsPage).not.toContain('Auto (SearXNG > DDG)')
  })
})

describe('die Einstellungen kommen beim Rust-Befehl an', () => {
  it('Stufe, Schluessel und User-Agent', async () => {
    h.settings = { searchProvider: 'wikipedia', exaApiKey: '  exa-1  ', braveApiKey: 'BSA', tavilyApiKey: '', searchUserAgent: 'MyBot/1.0' }
    backendCall.mockResolvedValue({ results: [{ title: 't', url: 'https://x.example/', snippet: 's' }] })
    await registry.execute('web_search', { query: 'tea', maxResults: 3 })
    expect(backendCall.mock.calls[0][0]).toBe('web_search')
    expect(backendCall.mock.calls[0][1]).toEqual({
      query: 'tea',
      count: 3,
      provider: 'wikipedia',
      braveApiKey: 'BSA',
      tavilyApiKey: '',
      exaApiKey: 'exa-1',
      userAgent: 'MyBot/1.0',
    })
  })

  it('ein alter Store ohne Exa-Feld und mit unbekannter Stufe sucht mit Auto ohne Schluessel', async () => {
    h.settings = { searchProvider: 'bing' }
    backendCall.mockResolvedValue({ results: [{ title: 't', url: 'https://x.example/', snippet: 's' }] })
    await registry.execute('web_search', { query: 'tea' })
    expect(backendCall.mock.calls[0][1]).toMatchObject({ provider: 'auto', exaApiKey: '' })
  })
})

describe('web_fetch', () => {
  it('sagt, wenn Exa die Seite gelesen hat, und warum', async () => {
    backendCall.mockResolvedValue({
      url: 'https://spa.example/',
      status: 200,
      contentType: 'text/plain',
      title: 'App',
      text: 'The text Exa read.',
      truncated: false,
      via: 'exa',
      localProblem: 'the site answered HTTP 403',
    })
    const out = (await registry.execute('web_fetch', { url: 'https://spa.example/' })) as string
    expect(out).toContain('Read via Exa: the site answered HTTP 403.')
    expect(out).toContain('The text Exa read.')
    expect(toolResultIsFailure(out)).toBe(false)
  })

  it('liest bis 40 000 Zeichen', async () => {
    const tool = registry.getAll().find((t) => t.name === 'web_fetch')!
    expect(tool.description).toContain('~40 000 chars')
    backendCall.mockResolvedValue({ url: 'https://x.example/', status: 200, contentType: 'text/html', title: 'T', text: 'a', truncated: true })
    const out = (await registry.execute('web_fetch', { url: 'https://x.example/' })) as string
    expect(out).toContain('…(truncated to 40 000 chars)')
  })
})
