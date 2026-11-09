/**
 * D16 (3.0.7): der User-Agent der Websuche ist einstellbar.
 *
 * Settings, Search Provider, User-Agent. Leer bleibt alles wie bisher: jede
 * freie Suchstufe und `web_fetch` schicken ihren eigenen. Gesetzt geht er an
 * beide Rust-Befehle, ohne Leerzeichen drumherum; geprueft wird er dort
 * noch einmal (`search::custom_user_agent`).
 *
 * Diese Datei nagelt die Strecke vom Store bis zum backendCall fest, durch das
 * echte ToolRegistry, und die Saetze, die das Feld unter Settings zeigt.
 *
 * Run: npx vitest run src/api/mcp/__tests__/der-user-agent-der-websuche-kommt-an.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
// P-L (3.1.0): the address gate has its own tests (lib/__tests__/web-research-und-quellen.test.ts).
vi.mock('../../../lib/web-url-provenance', () => ({ guardWebUrl: async () => null, rememberUrls: () => {} }))

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
import { userAgentProblem, searchUserAgentArg, MAX_USER_AGENT_LEN } from '../../../lib/search-user-agent'
import { DEFAULT_SETTINGS } from '../../../lib/constants'
import { SETTINGS_TAB_RESET_KEYS } from '../../../lib/settings-reset'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

beforeEach(() => {
  backendCall.mockReset()
  h.settings = {}
})

describe('der User-Agent aus Settings erreicht beide Befehle', () => {
  it('web_search bekommt ihn, ohne Leerzeichen drumherum', async () => {
    h.settings = { searchUserAgent: '  MyBot/1.0  ' }
    backendCall.mockResolvedValue({ results: [{ title: 't', url: 'https://x', snippet: 's' }] })
    await registry.execute('web_search', { query: 'tea' })
    expect(backendCall.mock.calls[0][0]).toBe('web_search')
    expect(backendCall.mock.calls[0][1]).toMatchObject({ query: 'tea', userAgent: 'MyBot/1.0' })
  })

  it('web_fetch bekommt ihn', async () => {
    h.settings = { searchUserAgent: 'MyBot/1.0' }
    backendCall.mockResolvedValue({ status: 200, url: 'https://x', title: 't', text: 'body', truncated: false })
    await registry.execute('web_fetch', { url: 'https://example.org/' })
    expect(backendCall.mock.calls[0][0]).toBe('web_fetch')
    expect(backendCall.mock.calls[0][1]).toEqual({ url: 'https://example.org/', userAgent: 'MyBot/1.0' })
  })

  it('leer oder nie gesetzt heisst: der bisherige, also ein leerer Wert', async () => {
    backendCall.mockResolvedValue({ results: [{ title: 't', url: 'https://x', snippet: 's' }] })
    await registry.execute('web_search', { query: 'tea' })
    expect(backendCall.mock.calls[0][1]).toMatchObject({ userAgent: '' })
    h.settings = { searchUserAgent: '   ' }
    backendCall.mockResolvedValue({ status: 200, url: 'https://x', title: 't', text: 'body', truncated: false })
    await registry.execute('web_fetch', { url: 'https://example.org/' })
    expect(backendCall.mock.calls[1][1]).toEqual({ url: 'https://example.org/', userAgent: '' })
  })
})

describe('was das Feld sagt', () => {
  it('ein brauchbarer oder leerer Wert ist kein Problem', () => {
    expect(userAgentProblem(undefined)).toBeNull()
    expect(userAgentProblem('')).toBeNull()
    expect(userAgentProblem('Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0')).toBeNull()
    expect(searchUserAgentArg(undefined)).toBe('')
  })

  it('was Rust nicht schickt, nennt das Feld, und sagt, dass der Standard geht', () => {
    for (const bad of ['Bot\nX', 'Böt/1.0', 'Bot\t1', 'a'.repeat(MAX_USER_AGENT_LEN + 1)]) {
      const msg = userAgentProblem(bad)
      expect(msg, JSON.stringify(bad)).toMatch(/the default is sent instead\.$/)
      expect(msg).not.toMatch(/—/)
    }
    expect(userAgentProblem('a'.repeat(MAX_USER_AGENT_LEN))).toBeNull()
  })

  it('der Standard ist leer, und Reset im Agent-Reiter setzt ihn zurueck', () => {
    expect(DEFAULT_SETTINGS.searchUserAgent).toBe('')
    expect(SETTINGS_TAB_RESET_KEYS.agent).toContain('searchUserAgent')
  })
})
