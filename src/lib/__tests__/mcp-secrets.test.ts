/**
 * @vitest-environment jsdom
 *
 * M1: token and headers of a URL server. In this test there is no vault (no
 * Tauri), which is the Linux and web case: the value falls back to
 * localStorage, obfuscated like the provider keys there, never in plain text.
 *
 * Run: npx vitest run src/lib/__tests__/mcp-secrets.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { deleteMcpAuth, hasMcpAuth, loadMcpAuth, mcpSecretAccount, parseHeaderLines, saveMcpAuth } from '../mcp-secrets'

beforeEach(() => localStorage.clear())

describe('mcp secrets', () => {
  it('round-trips without a vault and never stores the token in plain text', async () => {
    await saveMcpAuth('3f2a-UUID', { token: 'tok-plain-123', headers: { 'X-Key': 'v' } })
    expect(JSON.stringify(localStorage)).not.toContain('tok-plain-123')
    expect(await loadMcpAuth('3f2a-UUID')).toEqual({ token: 'tok-plain-123', headers: { 'X-Key': 'v' } })
    await deleteMcpAuth('3f2a-UUID')
    expect(await loadMcpAuth('3f2a-UUID')).toBeNull()
  })

  it('saving nothing removes what was there', async () => {
    await saveMcpAuth('a', { token: 't' })
    await saveMcpAuth('a', { token: '  ', headers: {} })
    expect(await loadMcpAuth('a')).toBeNull()
    expect(hasMcpAuth({ headers: { ' ': 'x' } })).toBe(false)
  })

  it('the vault account is a slug the Rust side takes', () => {
    expect(mcpSecretAccount('6F1C2B9E-1234-4D5E-8F90-ABCDEF012345')).toMatch(/^[a-z0-9-]{1,64}$/)
  })

  it('reads headers one per line and skips what is not a header', () => {
    expect(parseHeaderLines('X-Api-Key: abc\nno colon\n: empty\nBad Name: x\nAuthorization: Basic a:b')).toEqual({
      'X-Api-Key': 'abc',
      Authorization: 'Basic a:b',
    })
  })
})
