/**
 * The other half of A9: the button is only worth showing in Cloud mode if the
 * document context actually reaches a cloud model.
 *
 * It does, and this file proves it on the wire rather than by reading source.
 * Retrieval never talks to the chat provider. It builds a block of passages
 * (lib/rag-prompt.ts), the block is appended to the SYSTEM prompt, and a system
 * message is the one thing Ollama, the built-in engine, LM Studio and LU Cloud
 * all accept. Nothing in that path is local-only, which is why hiding the Docs
 * button on `appMode === 'cloud'` was a guess and not a limit.
 *
 * The request below goes out through LuCloudProvider, the real one, against a
 * spied fetch. What we assert is the JSON body: the passages are in the system
 * message, and the bearer is the cloud session token, so this is the cloud
 * lane and not a local one wearing its name.
 *
 * Negative controls, because "the text appears somewhere" is not a proof:
 *   - no retrieval hits -> no instruction, no [Source], nothing paid for
 *   - RAG switched off  -> the system prompt goes out byte for byte unchanged
 *   - the document text is nowhere in the body when RAG is off, so a passing
 *     positive case cannot be some other part of the payload
 *
 * Run: npx vitest run src/api/__tests__/rag-context-reaches-the-cloud.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildRagSuffix, RAG_INSTRUCTION } from '../../lib/rag-prompt'
import { LuCloudProvider } from '../providers/lu-cloud-provider'
import type { ProviderConfig } from '../providers/types'

vi.mock('../cloud/supabase', () => ({
  getAccessToken: async () => 'session-token-abc',
}))

const config: ProviderConfig = {
  id: 'lu-cloud',
  name: 'LU Cloud',
  enabled: true,
  baseUrl: 'https://lu-labs.ai/api/inference/v1',
  apiKey: '',
  isLocal: false,
}

const okStream = () =>
  new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200 })

/** The passage a user's PDF would contribute after chunking and ranking. */
const SECRET = 'The service level target for the Bergheim site is 99.95 percent.'

async function drain(gen: AsyncGenerator<any>) {
  for await (const _ of gen) { /* the fetch only happens on the first next() */ }
}

/** Send one turn through the real cloud provider and hand back the JSON body. */
async function sendCloudTurn(systemPrompt: string) {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okStream())
  await drain(
    new LuCloudProvider(config).chatStream(
      'zai-org/GLM-5.3',
      [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: 'What is the target for Bergheim?' },
      ],
      {},
    ),
  )
  const [url, init] = spy.mock.calls[0] as [string, RequestInit]
  return { url, init, body: JSON.parse(init.body as string) }
}

afterEach(() => vi.restoreAllMocks())

describe('the retrieval block is built the same way for every provider', () => {
  it('numbers the passages and wraps them in one instruction', () => {
    const suffix = buildRagSuffix([{ content: SECRET }, { content: 'Second passage.' }])
    expect(suffix).toContain(RAG_INSTRUCTION)
    expect(suffix).toContain('[Source 1]\n' + SECRET)
    expect(suffix).toContain('[Source 2]\nSecond passage.')
  })

  it('says nothing at all when retrieval found nothing', () => {
    // Negative control: an instruction pointing at an empty context is tokens
    // spent on noise, on every turn, in a mode where tokens are money.
    expect(buildRagSuffix([])).toBe('')
  })

  it('rides at the END of the prompt, so the upstream prefix cache still matches', () => {
    const persona = 'You are a terse assistant.'
    const full = persona + buildRagSuffix([{ content: SECRET }])
    expect(full.startsWith(persona)).toBe(true)
    expect(full.indexOf('[Source 1]')).toBeGreaterThan(full.indexOf(persona))
  })
})

describe('a cloud request carries the document context', () => {
  it('the passages arrive in the system message of the LU Cloud request', async () => {
    const systemPrompt = 'You are a terse assistant.' + buildRagSuffix([{ content: SECRET }])
    const { url, init, body } = await sendCloudTurn(systemPrompt)

    // This really is the cloud lane: hosted endpoint, session bearer.
    expect(String(url)).toContain('/api/inference/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-token-abc')

    const system = body.messages.find((m: any) => m.role === 'system')
    expect(system).toBeDefined()
    expect(system.content).toContain(SECRET)
    expect(system.content).toContain('[Source 1]')
    expect(system.content).toContain(RAG_INSTRUCTION)
    // The persona is still in front of the retrieval block on the wire.
    expect(system.content.indexOf('terse assistant')).toBeLessThan(system.content.indexOf('[Source 1]'))
  })

  it('with RAG off the same turn goes out clean, so the positive case proved something', async () => {
    // Negative control on the whole request: no suffix, no document text
    // anywhere in the payload, and the system prompt byte for byte unchanged.
    const systemPrompt = 'You are a terse assistant.'
    const { body, init } = await sendCloudTurn(systemPrompt)

    const system = body.messages.find((m: any) => m.role === 'system')
    expect(system.content).toBe(systemPrompt)
    expect(String(init.body)).not.toContain('Bergheim site is 99.95')
    expect(String(init.body)).not.toContain('[Source 1]')
    expect(String(init.body)).not.toContain(RAG_INSTRUCTION)
  })

  it('an empty retrieval leaves the cloud request identical to no RAG at all', async () => {
    const persona = 'You are a terse assistant.'
    const withEmptyRag = persona + buildRagSuffix([])
    const a = await sendCloudTurn(withEmptyRag)
    vi.restoreAllMocks()
    const b = await sendCloudTurn(persona)
    expect(a.init.body).toBe(b.init.body)
  })
})
