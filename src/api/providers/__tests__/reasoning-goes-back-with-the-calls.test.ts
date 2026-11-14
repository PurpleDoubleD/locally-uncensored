/**
 * CA, cloud loops (13.11.2026): an agent step's own reasoning goes back with
 * its tool calls as `reasoning_content`, where the provider asks for it (LU
 * Cloud), and nowhere else. lib/agent-core/reasoning-replay.ts says why.
 *
 * Driven through a real provider call with a stubbed fetch: the request body
 * is what the upstream model sees.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '../openai-provider'
import type { ChatMessage, ProviderConfig } from '../types'
import { replayableReasoning, REPLAY_REASONING_CHARS } from '../../../lib/agent-core/reasoning-replay'

function config(replayReasoning?: boolean): ProviderConfig {
  return {
    id: 'openai', name: 'OpenAI', enabled: true,
    baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', isLocal: false,
    ...(replayReasoning === undefined ? {} : { replayReasoning }),
  }
}

function okResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }), { status: 200 })
}

const RUN: ChatMessage[] = [
  { role: 'user', content: 'fix the parser' },
  {
    role: 'assistant', content: '', reasoning: 'The bug is in parse(); read src/parse.ts first.',
    tool_calls: [{ id: 'call_1', function: { name: 'file_read', arguments: { path: 'src/parse.ts' } } }],
  },
  { role: 'tool', content: 'export function parse() {}', tool_call_id: 'call_1' },
]

async function bodyOf(cfg: ProviderConfig): Promise<{ messages: Array<Record<string, unknown>> }> {
  const fetchMock = vi.fn().mockResolvedValue(okResponse())
  vi.stubGlobal('fetch', fetchMock)
  await new OpenAIProvider(cfg).chatWithTools('gpt-4o', RUN, [])
  return JSON.parse(fetchMock.mock.calls[0][1].body as string)
}

afterEach(() => vi.unstubAllGlobals())

describe('reasoning_content on the wire', () => {
  it('goes back with the step that made the call, where the provider asks for it', async () => {
    const body = await bodyOf(config(true))
    const step = body.messages.find((m) => m.role === 'assistant')!
    expect(step.reasoning_content).toBe('The bug is in parse(); read src/parse.ts first.')
    expect(step.tool_calls).toHaveLength(1)
    // Never on the other roles.
    expect(body.messages.filter((m) => 'reasoning_content' in m)).toHaveLength(1)
  })

  it('is not sent to a provider that did not ask for it', async () => {
    for (const cfg of [config(), config(false)]) {
      const body = await bodyOf(cfg)
      expect(body.messages.some((m) => 'reasoning_content' in m)).toBe(false)
    }
  })
})

describe('replayableReasoning', () => {
  it('nothing for nothing', () => {
    expect(replayableReasoning(undefined)).toBeUndefined()
    expect(replayableReasoning('   ')).toBeUndefined()
  })

  it('keeps a normal step whole', () => {
    expect(replayableReasoning(' plan: read, then edit ')).toBe('plan: read, then edit')
  })

  it('keeps the END of a very long one, where the decision is', () => {
    const long = 'x'.repeat(REPLAY_REASONING_CHARS) + 'DECISION: call file_edit'
    const out = replayableReasoning(long)!
    expect(out.length).toBeLessThanOrEqual(REPLAY_REASONING_CHARS + 4)
    expect(out.endsWith('DECISION: call file_edit')).toBe(true)
    expect(out.startsWith('[…]')).toBe(true)
  })
})

describe('LU Cloud asks for it', () => {
  it('its provider sets replayReasoning', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../lu-cloud-provider.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/replayReasoning: true/)
  })

  it('all three loops attach the step reasoning to the assistant turn with the calls', async () => {
    const { readFileSync } = await import('node:fs')
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    expect(read('../../../hooks/useAgentChat.ts')).toMatch(/reasoning: replayableReasoning\(turnThinking\)/)
    expect(read('../../../hooks/useCodex.ts')).toMatch(/tool_calls: toolCalls, reasoning: replayableReasoning\(turnReasoning\)/)
    expect(read('../../agents/sub-agent.ts')).toMatch(/reasoning: replayableReasoning\(raw\.thinking\)/)
  })
})
