/**
 * What Create says when the render queue answers 429 (src/hooks/useCloudCreate.ts).
 *
 * LU Cloud answers 429 for three different things — the per-user burst guard,
 * an upstream provider throttle, and an empty wallet (lib/http-status carries
 * the same policy for the chat path). All three used to reach the user as
 * "Monthly credit budget exhausted, upgrade your plan", so a subscriber who
 * had simply clicked twice too fast was told to buy a bigger plan while the
 * credits meter next to the message still showed a balance. On a billed
 * product that is a false sales pitch, so the wallet case has to be identified
 * rather than assumed.
 */
import { describe, it, expect } from 'vitest'
import { throttleMessage } from '../useCloudCreate'
import { CloudJobError } from '../../api/cloud/client'

const UPGRADE = /upgrade your plan/

describe('the wallet case, and only the wallet case, mentions the plan', () => {
  it('trusts the server code', () => {
    const err = new CloudJobError('too many requests', 429, { code: 'credits_exhausted' })
    expect(throttleMessage(err)).toMatch(UPGRADE)
  })

  it('and the message the server sends today, in case the code is absent', () => {
    expect(throttleMessage(new CloudJobError('monthly credit budget exhausted', 429))).toMatch(UPGRADE)
  })
})

describe('a throttle is named as a throttle', () => {
  it('says wait, not pay, for the per-user burst guard', () => {
    const err = new CloudJobError('too many requests', 429, { retryAfterMs: 42_000 })
    const msg = throttleMessage(err)
    expect(msg).not.toMatch(UPGRADE)
    expect(msg).toMatch(/not your credit balance/)
    // The burst window is fixed and up to a minute long — retry-after is the
    // only number that tells the user when it is actually worth clicking.
    expect(msg).toContain('42s')
  })

  it('says the same without a retry-after header', () => {
    const err = new CloudJobError('provider is rate limiting', 429)
    const msg = throttleMessage(err)
    expect(msg).not.toMatch(UPGRADE)
    expect(msg).toMatch(/try again/i)
  })

  it('does not invent a countdown from a missing or zero wait', () => {
    for (const meta of [undefined, { retryAfterMs: 0 }]) {
      expect(throttleMessage(new CloudJobError('slow down', 429, meta))).not.toMatch(/\d+s\b/)
    }
  })

  it('rounds a sub-second wait up rather than telling the user 0s', () => {
    expect(throttleMessage(new CloudJobError('slow down', 429, { retryAfterMs: 250 }))).toContain('1s')
  })
})

describe('the metadata the message needs actually survives the client', () => {
  it('jsonOrError carries code and retry-after off the response', async () => {
    const { jsonOrError } = await import('../../api/cloud/client')
    const res = new Response(JSON.stringify({ error: 'too many requests', code: 'rate_limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    })
    const err = (await jsonOrError(res).catch((e: unknown) => e)) as CloudJobError
    expect(err.code).toBe('rate_limited')
    expect(err.retryAfterMs).toBe(30_000)
    expect(throttleMessage(err)).toContain('30s')
  })
})
