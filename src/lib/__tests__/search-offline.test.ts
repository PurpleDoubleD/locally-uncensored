/**
 * @vitest-environment jsdom
 *
 * Second check on Android with 8 GB, F7: without a network "Test search"
 * showed the text of the system and advised a Brave key, and the model wrote
 * that the search function is not working.
 *
 * Here: what counts as "no network" (lib/search-offline.ts), what the model
 * is given by the real `web_search` tool on a phone, and that a desktop
 * keeps the text it had.
 *
 * Run: npx vitest run src/lib/__tests__/search-offline.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// P-L (3.1.0): the address gate has its own tests (lib/__tests__/web-research-und-quellen.test.ts).
vi.mock('../web-url-provenance', () => ({ guardWebUrl: async () => null, rememberUrls: () => {} }))

const backendCall = vi.fn(async (..._args: unknown[]) => ({}) as unknown)
vi.mock('../../api/backend', async (orig) => ({
  ...(await orig<typeof import('../../api/backend')>()),
  backendCall: (...a: unknown[]) => backendCall(...a),
}))
vi.mock('../../api/agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../search-keys', () => ({ resolveSearchCall: async () => ({ provider: 'auto', braveApiKey: '', tavilyApiKey: '' }) }))

import { registerBuiltinTools } from '../../api/mcp/builtin-tools'
import { ToolRegistry } from '../../api/mcp/tool-registry'
import { NATIVE_HOST_KEY } from '../device-kind'
import { FETCH_OFFLINE_TOOL_RESULT, SEARCH_OFFLINE_TOOL_RESULT, deviceSaysOffline, reasonSaysNoNetwork, searchFailedOffline } from '../search-offline'
import { readSearchAnswer, readSearchError } from '../../mobile/screens/agent/parts/search-logic'
import { AGENT_STRINGS } from '../../mobile/strings/agent'

/** The answer of the search command in flight mode, word for word as the check saw it on Android. */
const LOOKUP = 'could not connect (failed to lookup address information: No address associated with hostname)'
const FLIGHT_MODE = {
  results: [],
  error: `All search tiers failed. DuckDuckGo: ${LOOKUP}. Wikipedia: ${LOOKUP}. The free search is not dependable. Add a Brave or Tavily key under Settings, Web search for dependable search.`,
  tiers: [{ tier: 'DuckDuckGo', error: LOOKUP }, { tier: 'Wikipedia', error: LOOKUP }],
}
/** The internet is there and the searches did not deliver: the advice of the command fits. */
const BOT_CHECK = {
  results: [],
  error: 'All search tiers failed. DuckDuckGo: answered with a bot check instead of results (HTTP 202). Wikipedia: HTTP 403. The free search is not dependable. Add a Brave or Tavily key under Settings, Web search for dependable search.',
  tiers: [{ tier: 'DuckDuckGo', error: 'answered with a bot check instead of results (HTTP 202)' }, { tier: 'Wikipedia', error: 'HTTP 403' }],
}

const host = (kind: string | null) => {
  const w = window as unknown as Record<string, unknown>
  if (kind) w[NATIVE_HOST_KEY] = kind
  else delete w[NATIVE_HOST_KEY]
}
const online = (value: boolean) => Object.defineProperty(navigator, 'onLine', { value, configurable: true })

const registry = new ToolRegistry()
registerBuiltinTools(registry)

beforeEach(() => {
  backendCall.mockReset()
  online(true)
})
afterEach(() => {
  host(null)
  online(true)
})

describe('what counts as "no network"', () => {
  it('the name of the host could not be looked up, or there is no route, in the words of each system', () => {
    for (const reason of [
      LOOKUP,
      'could not connect (failed to lookup address information: nodename nor servname provided, or not known)',
      'could not connect (failed to lookup address information: Temporary failure in name resolution)',
      'could not connect (dns error)',
      'could not connect (Network is unreachable (os error 101))',
      'the request failed (The Internet connection appears to be offline.)',
      'could not connect (No route to host)',
    ]) expect(reasonSaysNoNetwork(reason), reason).toBe(true)
  })

  it('an answer from somewhere is not: a status, a bot check, a timeout, a refused connection', () => {
    for (const reason of ['HTTP 403', 'answered with a bot check instead of results (HTTP 202)', 'timed out', 'could not connect (Connection refused)', 'the answer could not be read', '', undefined, null, 42]) {
      expect(reasonSaysNoNetwork(reason), String(reason)).toBe(false)
    }
  })

  it('a search failed offline only when it found nothing and every search that was asked failed that way', () => {
    expect(searchFailedOffline(FLIGHT_MODE)).toBe(true)
    expect(searchFailedOffline(BOT_CHECK)).toBe(false)
    expect(searchFailedOffline({ ...FLIGHT_MODE, tiers: [FLIGHT_MODE.tiers[0], { tier: 'Wikipedia', error: 'HTTP 403' }] })).toBe(false)
    expect(searchFailedOffline({ ...FLIGHT_MODE, results: [{ title: 't', url: 'https://x', snippet: 's' }] })).toBe(false)
    // The user's own provider is one of the searches that were asked.
    expect(searchFailedOffline({ ...FLIGHT_MODE, providerError: `Brave: ${LOOKUP}` })).toBe(true)
    expect(searchFailedOffline({ ...FLIGHT_MODE, providerError: 'Brave: HTTP 401, the key was refused' })).toBe(false)
    // An error without the list of tiers has only its text.
    expect(searchFailedOffline({ error: `error sending request: ${LOOKUP}` })).toBe(true)
    expect(searchFailedOffline({ error: 'No provider answered.' })).toBe(false)
    expect(searchFailedOffline(null)).toBe(false)
  })
})

describe('"Test search" without a network', () => {
  it('says the one sentence: no system text, no advice to add a key', () => {
    expect(readSearchAnswer(FLIGHT_MODE)).toEqual({ kind: 'offline' })
    const sentence = AGENT_STRINGS.webSearch.testOffline
    expect(sentence).toBe('This phone has no internet connection, so the search did not run. Connect to Wi-Fi or mobile data and try again.')
    expect(sentence).not.toMatch(/lookup|hostname|Brave|Tavily|key|tier|[–—]/i)
  })

  it('a search that threw for the same reason, or while the phone says it is offline, is the same outcome', () => {
    expect(readSearchError(new Error(`web_search: ${LOOKUP}`))).toEqual({ kind: 'offline' })
    expect(readSearchError(new Error('anything'), { offline: true })).toEqual({ kind: 'offline' })
    expect(readSearchError(new Error('No provider answered.'))).toEqual({ kind: 'failed', reason: 'No provider answered.' })
    expect(readSearchAnswer(null, { offline: true })).toEqual({ kind: 'offline' })
  })

  it('with a network, a search that did not deliver keeps the reasons and the advice of the command', () => {
    const outcome = readSearchAnswer(BOT_CHECK)
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.reason).toContain('Add a Brave or Tavily key')
  })
})

describe('the web_search tool on a phone without a network', () => {
  beforeEach(() => host('android'))

  it('the phone says it is offline: nothing is asked, and the model is told so in one sentence', async () => {
    online(false)
    expect(deviceSaysOffline()).toBe(true)
    const out = (await registry.execute('web_search', { query: 'who won' })) as string
    expect(backendCall).not.toHaveBeenCalled()
    expect(out).toBe(SEARCH_OFFLINE_TOOL_RESULT)
  })

  it('the phone says it is online and every search still fails to leave it: the same sentence, not the text of the system', async () => {
    backendCall.mockResolvedValue(FLIGHT_MODE)
    const out = (await registry.execute('web_search', { query: 'who won' })) as string
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(out).toBe(SEARCH_OFFLINE_TOOL_RESULT)
    expect(out).not.toMatch(/lookup|hostname|Brave|Tavily|not dependable/)
  })

  it('what the model is given is a failed step, names the cause and says what to tell the user', () => {
    for (const text of [SEARCH_OFFLINE_TOOL_RESULT, FETCH_OFFLINE_TOOL_RESULT]) {
      // The mark a failed tool step is known by (lib/workflow-engine.ts, executeToolStep).
      expect(text.startsWith('Error:')).toBe(true)
      expect(text).toContain('no internet connection')
      expect(text).toMatch(/Tell the user/)
      expect(text).not.toMatch(/[–—]/)
    }
  })

  it('with a network, a failure is passed on as before', async () => {
    backendCall.mockResolvedValue(BOT_CHECK)
    const out = (await registry.execute('web_search', { query: 'who won' })) as string
    expect(out.startsWith('Error: Web search failed: All search tiers failed.')).toBe(true)
    expect(out).toContain('bot check')
  })

  it('reading a page: not asked while offline, an address on the device still is', async () => {
    online(false)
    expect(await registry.execute('web_fetch', { url: 'https://example.org/a' })).toBe(FETCH_OFFLINE_TOOL_RESULT)
    expect(backendCall).not.toHaveBeenCalled()
    backendCall.mockResolvedValue({ status: 200, title: 'Local', text: 'A page on this device with enough words to count as a page.', url: 'http://127.0.0.1:8080/' })
    await registry.execute('web_fetch', { url: 'http://127.0.0.1:8080/' })
    expect(backendCall).toHaveBeenCalledTimes(1)
  })
})

describe('a desktop keeps the text of the search command', () => {
  beforeEach(() => host('windows'))

  it('offline or not, the search is asked and its own reasons are passed on', async () => {
    online(false)
    backendCall.mockResolvedValue(FLIGHT_MODE)
    const out = (await registry.execute('web_search', { query: 'who won' })) as string
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(out).toBe(`Error: Web search failed: ${FLIGHT_MODE.error}`)
  })

  it('reading a page is asked as before', async () => {
    online(false)
    backendCall.mockResolvedValue({ status: 200, title: 'T', text: 'Some text of a page that is long enough.', url: 'https://example.org/a' })
    const out = (await registry.execute('web_fetch', { url: 'https://example.org/a' })) as string
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(out).not.toBe(FETCH_OFFLINE_TOOL_RESULT)
  })
})
