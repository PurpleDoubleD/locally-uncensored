/**
 * LU Cloud (lu-labs.ai chat proxy) answers three requests that cannot work as
 * they are with a code of their own since 19.11.2026: images_too_large (413),
 * request_too_large (413), unsupported_response_format (422), each with an
 * English sentence. In the desktop app, Chat and Agent: the sentence is what
 * the user reads, and the request is sent exactly once. No provider ladder,
 * no thinking downgrade, no agent retry. Statuses as the proxy sends them
 * (the chat completions route of the proxy); each code is also
 * checked as a 422, the status the announcement named.
 *
 * Run: npx vitest run src/api/providers/__tests__/cloud-final-codes.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatStreamChunk } from '../types'
import type { FetchArgs } from '../../__tests__/provider-test-support'

/** The proxy's own sentences, word for word. */
const CASES = [
  {
    code: 'images_too_large', status: 413,
    error: 'The images in this message are too large to send in one request (about 52 MB, at most 40 MB). Nothing was generated and no credits were charged. Send fewer or smaller images, then send the message again.',
  },
  {
    code: 'request_too_large', status: 413,
    error: 'This request is too large for Kimi K2.6: the images and the conversation together exceed what it takes in one request. Nothing was generated and no credits were charged. Send fewer or smaller images, or start a new chat, then send the message again.',
  },
  {
    code: 'unsupported_response_format', status: 422,
    error: 'Kimi K2.6 could not follow the JSON format this request asked for, so nothing was generated and no credits were charged. Send the message again without a response format, or with a simpler schema that does not refer to itself.',
  },
] as const

let posts = 0
let answer: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }

function reply() {
  posts++
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
}

async function makeCloud() {
  vi.resetModules()
  posts = 0
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(async () => reply()),
    localFetchStream: vi.fn(async () => reply()),
    backendCall: vi.fn(),
    isPrivateOrLanHost: () => false,
    isDirectFetchAllowed: () => true,
    hostnameOf: (url: string) => new URL(url).hostname,
    ensureProxyAllowsHost: vi.fn(),
    isTauri: () => false,
  }))
  vi.doMock('../../cloud/supabase', () => ({ getAccessToken: vi.fn(async () => 'token') }))
  vi.doMock('../../../lib/cloud-outage-watch', () => ({ outageAfterFailure: vi.fn(async () => null) }))
  const mod = await import('../lu-cloud-provider')
  return new mod.LuCloudProvider({ id: 'lu-cloud', name: 'LU Cloud', apiKey: '', enabled: true, baseUrl: '', isLocal: false })
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>) {
  for await (const _ of gen) { /* the error comes on the first next() */ }
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: FetchArgs[0], _i: FetchArgs[1]) => reply())
})
afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../cloud/supabase')
  vi.doUnmock('../../../lib/cloud-outage-watch')
  vi.restoreAllMocks()
  vi.resetModules()
})

for (const c of CASES) {
  for (const status of new Set([c.status, 422])) {
    describe(`${c.code} (HTTP ${status})`, () => {
      beforeEach(() => { answer = { status, body: { error: c.error, code: c.code, model: 'kimi-k2.6' } } })

      it('Chat: the proxy\'s sentence, one request, thinking on or off', async () => {
        for (const thinking of [true, false]) {
          const cloud = await makeCloud()
          const err = await drain(cloud.chatStream('kimi-k2.6', [{ role: 'user', content: 'hi' }], { thinking })).then(() => null, (e: unknown) => e)
          expect((err as Error).message).toBe(c.error)
          expect((err as { code?: string }).code).toBe(c.code)
          expect(posts).toBe(1)
        }
      })

      it('Agent: the tool turn gets the same sentence after one request', async () => {
        const cloud = await makeCloud()
        const err = await cloud.chatWithTools('kimi-k2.6', [{ role: 'user', content: 'hi' }], [], { thinking: true }).then(() => null, (e: unknown) => e)
        expect((err as Error).message).toBe(c.error)
        expect(posts).toBe(1)
      })

      it('no retry anywhere above the provider: not the thinking downgrade, not the agent loop', async () => {
        const cloud = await makeCloud()
        const err = await drain(cloud.chatStream('kimi-k2.6', [{ role: 'user', content: 'hi' }], { thinking: true })).then(() => null, (e: unknown) => e)
        const { shouldDowngradeThinking } = await import('../../../hooks/codex/thinking-downgrade')
        const { isTerminalModelError } = await import('../../../lib/http-status')
        expect(shouldDowngradeThinking(true, err)).toBe(false)
        expect(isTerminalModelError(err)).toBe(true)
      })
    })
  }
}

describe('NEGATIVE CONTROL: a plain 422 without such a code still walks the thinking ladder', () => {
  it('resends with a lighter thinking knob', async () => {
    answer = { status: 422, body: { error: 'reasoning_effort none is not supported' } }
    const cloud = await makeCloud()
    await drain(cloud.chatStream('kimi-k2.6', [{ role: 'user', content: 'hi' }], { thinking: false })).catch(() => {})
    expect(posts).toBeGreaterThan(1)
  })
})
