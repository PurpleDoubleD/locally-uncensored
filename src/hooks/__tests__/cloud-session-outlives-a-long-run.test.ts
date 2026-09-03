/**
 * An hour into an agent run, the cloud token ages out. The run must not.
 *
 * Review 2026-08-14. LU Cloud's bearer is a Supabase access token with a life
 * of about an hour, and LuCloudProvider.delegate() calls getAccessToken()
 * afresh on every single call, so the retry IS the refresh. The 4xx guard
 * classified 401 as terminal, which threw that away: the run ended at the
 * first refusal, and the user, who is signed in and watching, read
 * "unauthenticated" or, on an opaque body, "Invalid API key for LU Cloud.
 * Check Settings > Providers." for a provider that has no API key field.
 *
 * The same cloud already states the policy on its jobs path
 * (api/cloud/jobs.ts): 401 stays retryable so a failed lazy refresh never
 * tells a signed-in user to sign in.
 *
 * Run: npx vitest run src/hooks/__tests__/cloud-session-outlives-a-long-run.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const provider = read('../../api/providers/lu-cloud-provider.ts')
const agent = read('../useAgentChat.ts')
const chat = read('../useChat.ts')
const jobs = read('../../api/cloud/jobs.ts')

describe('the retry is the refresh', () => {
  it('every call mints its own token, so attempt two is a different request', () => {
    const delegate = provider.slice(
      provider.indexOf('private async delegate'),
      provider.indexOf('async *chatStream'),
    )
    expect(delegate).toContain('await getAccessToken()')
    // chatStream must go through delegate(), not a cached client.
    expect(provider).toContain('const inner = await this.delegate()')
  })

  it('no session at all is tagged apart, that one no retry can fix', () => {
    expect(provider).toContain("'lu-cloud', 'signed_out', 401")
  })
})

describe('the dead end says the true thing', () => {
  it('the agent has a branch for it instead of falling into "Agent error"', () => {
    const branch = agent.indexOf("code === 'signed_out'")
    const generic = agent.indexOf("'\\n\\nAgent error: ' + errorMsg")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(generic)
    expect(agent).toContain('Your LU Cloud session ended and could not be renewed')
    // Same treatment as an empty wallet: a /loop must not run on into it.
    expect(agent).toContain("loopHalt = 'signed out of LU Cloud'")
  })

  it('plain chat prints the sentence instead of wrapping it in "Error:"', () => {
    // Auf die Eigenschaft gepinnt, nicht auf eine Schreibweise: der frühere
    // Pin verlangte woertlich `(err as any).code`, also genau den Typ-Verzicht,
    // durch den die drei Codes gelesen wurden. Was gelten muss, ist die
    // Verzweigung — 'auth' und 'signed_out' landen in dem Zweig, der die
    // Meldung UNVERAENDERT nimmt, und der steht vor dem "Error: …"-Zweig.
    const authAt = chat.indexOf("=== 'auth'")
    const wrapAt = chat.indexOf('`Error: ${')
    expect(authAt).toBeGreaterThan(-1)
    expect(wrapAt).toBeGreaterThan(-1)
    expect(authAt).toBeLessThan(wrapAt)
    const decision = chat.slice(authAt, wrapAt)
    expect(decision).toContain("=== 'signed_out'")
    // Der Zweig dazwischen darf die Meldung nicht einpacken.
    expect(decision).not.toContain('Error: ')
    // Und der Code wird an einem geprueften Typ gelesen, nicht an `any`.
    expect(chat).toContain('err instanceof ProviderError ? err.code : undefined')
  })
})

describe('the house policy is one policy', () => {
  it('the jobs path on the same cloud exempts 401 for the same reason', () => {
    expect(jobs).toContain('status !== 401 && status !== 408 && status !== 429')
  })
})
