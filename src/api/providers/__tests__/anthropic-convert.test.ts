/**
 * Audit B7 — Anthropic requires all tool_result blocks answering one
 * assistant turn in ONE user message. The agent loop pushes one tool-result
 * message per call, and the old string-only merge left two parallel calls as
 * two consecutive user messages, which the API rejects. Verified through the
 * request body chatWithTools actually sends.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicProvider } from '../anthropic-provider'
import type { ChatMessage } from '../types'
import type { MessagesBody, AnthropicRequestBlock } from '../anthropic-provider'
import type { FetchArgs } from '../../__tests__/provider-test-support'

function providerWithCapturedBody() {
  const provider = new AnthropicProvider({
    id: 'anthropic', name: 'Anthropic', enabled: true,
    baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test', isLocal: false,
  })
  // Typed as the provider's own request interface, so a renamed field in
  // MessagesBody breaks this test instead of silently reading `undefined`.
  const bodies: MessagesBody[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: FetchArgs[0], init: FetchArgs[1]) => {
    const body = init?.body
    if (typeof body !== 'string') throw new Error('capture had no JSON body')
    bodies.push(JSON.parse(body) as MessagesBody)
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 12, output_tokens: 3 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }))
  return { provider, bodies }
}

afterEach(() => vi.unstubAllGlobals())

describe('AnthropicProvider message conversion (audit B7)', () => {
  it('folds parallel tool results into one user message of blocks', async () => {
    const { provider, bodies } = providerWithCapturedBody()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'run both' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'toolu_1', function: { name: 'file_read', arguments: { path: 'a.ts' } } },
          { id: 'toolu_2', function: { name: 'file_read', arguments: { path: 'b.ts' } } },
        ],
      },
      { role: 'tool', content: 'contents of a', tool_call_id: 'toolu_1' },
      { role: 'tool', content: 'contents of b', tool_call_id: 'toolu_2' },
    ]
    await provider.chatWithTools('claude-opus-4-20250514', messages, [])
    const sent = bodies[0].messages
    // user, assistant(tool_use), ONE user carrying BOTH tool_result blocks
    expect(sent).toHaveLength(3)
    const resultMsg = sent[2]
    expect(resultMsg.role).toBe('user')
    expect(Array.isArray(resultMsg.content)).toBe(true)
    const blocks: AnthropicRequestBlock[] =
      typeof resultMsg.content === 'string' ? [] : resultMsg.content
    const ids = blocks.map(b => (b.type === 'tool_result' ? b.tool_use_id : undefined))
    expect(ids).toEqual(['toolu_1', 'toolu_2'])
  })

  it('returns real token usage', async () => {
    const { provider } = providerWithCapturedBody()
    const turn = await provider.chatWithTools('claude-opus-4-20250514', [{ role: 'user', content: 'hi' }], [])
    expect(turn.promptEvalCount).toBe(12)
    expect(turn.evalCount).toBe(3)
  })
})
