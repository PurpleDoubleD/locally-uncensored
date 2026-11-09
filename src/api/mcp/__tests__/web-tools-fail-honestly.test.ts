/**
 * Auflage 2.1 (lu-301/bau/review-offload2.md): `executeToolStep`
 * (workflow-engine.ts) recognizes a failed tool call ONLY by
 * `result.startsWith('Error:')`. `executeWebSearch` and `executeWebFetch`
 * (builtin-tools.ts) used to return failure text that did NOT start with
 * that prefix: a search failure ("Web search failed: ...") and a fetch
 * that got a non-2xx status or an empty body both counted as
 * `status: 'completed'`, so a workflow step that failed for a real reason
 * ran on as if it had succeeded. This is the reviewer's explanation for the
 * box's "Research Topic" run finishing in seconds with idle GPU: the chain
 * never actually stopped on the broken step.
 *
 * These tests exercise the two executors directly through the real
 * `ToolRegistry`, not a copy, same pattern as
 * web-fetch-nennt-den-grund-des-fallbacks.test.ts.
 *
 * Run: npx vitest run src/api/mcp/__tests__/web-tools-fail-honestly.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
// P-L (3.1.0): the address gate has its own tests (lib/__tests__/web-research-und-quellen.test.ts).
vi.mock('../../../lib/web-url-provenance', () => ({ guardWebUrl: async () => null, rememberUrls: () => {} }))

const backendCall = vi.fn(async (..._args: unknown[]) => ({}))

vi.mock('../../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
}))
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}))

import { registerBuiltinTools } from '../builtin-tools'
import { ToolRegistry } from '../tool-registry'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

/** The same check `executeToolStep` (workflow-engine.ts) runs on every tool
 *  result before deciding `status: 'completed'` vs `'failed'`. */
const isMarkedAsFailed = (result: string) => result.startsWith('Error:')

beforeEach(() => {
  backendCall.mockClear()
})

describe('executeWebSearch: a search failure now reads as a real error', () => {
  it('a provider error is marked failed (starts with "Error:")', async () => {
    backendCall.mockResolvedValue({ error: 'All search tiers failed' })
    const out = await registry.execute('web_search', { query: 'tea history' }) as string
    expect(isMarkedAsFailed(out)).toBe(true)
    expect(out).toContain('All search tiers failed')
  })

  it('Gegenprobe: real results are NOT marked failed', async () => {
    backendCall.mockResolvedValue({ results: [{ title: 't', url: 'https://x', snippet: 's' }] })
    const out = await registry.execute('web_search', { query: 'tea history' }) as string
    expect(isMarkedAsFailed(out)).toBe(false)
  })
})

describe('executeWebFetch: a bad response now reads as a real error', () => {
  it('a non-2xx status is marked failed', async () => {
    backendCall.mockResolvedValue({ url: 'https://x', status: 404, contentType: 'text/html', title: 'Not Found', text: 'nope', truncated: false })
    const out = await registry.execute('web_fetch', { url: 'https://x' }) as string
    expect(isMarkedAsFailed(out)).toBe(true)
    expect(out).toContain('404')
  })

  it('an empty body is marked failed even with a 200 status', async () => {
    backendCall.mockResolvedValue({ url: 'https://x', status: 200, contentType: 'text/html', title: '', text: '', truncated: false })
    const out = await registry.execute('web_fetch', { url: 'https://x' }) as string
    expect(isMarkedAsFailed(out)).toBe(true)
  })

  it('a file in place of a page is one sentence, marked failed, and no bytes (mobile B2)', async () => {
    const sentence = 'This address returned a PDF, not a page of text, so it cannot be read here. Use a different address, or tell the user what the link points to.'
    backendCall.mockResolvedValue({ url: 'https://x/a.pdf', status: 200, contentType: 'application/pdf', title: '', text: '', truncated: false, notText: sentence })
    const out = await registry.execute('web_fetch', { url: 'https://x/a.pdf' }) as string
    expect(out).toBe(`Error: ${sentence}`)
  })

  it('Gegenprobe: a real 200 with a body is NOT marked failed', async () => {
    backendCall.mockResolvedValue({ url: 'https://x', status: 200, contentType: 'text/html', title: 'Tea', text: 'The history of tea spans centuries.', truncated: false })
    const out = await registry.execute('web_fetch', { url: 'https://x' }) as string
    expect(isMarkedAsFailed(out)).toBe(false)
    expect(out).toContain('The history of tea spans centuries.')
  })
})
