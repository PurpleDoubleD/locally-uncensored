import { describe, expect, it } from 'vitest'
import { DEFAULT_SHELL_SANDBOX, seatbeltProfile, workspaceIsFenceable } from '../shell-sandbox'

describe('the agent shell sandbox, prepared (CA, E3)', () => {
  it('is off until David switches it on', () => {
    expect(DEFAULT_SHELL_SANDBOX).toBe('off')
  })

  it('closes the home folder and opens the workspace, temp and toolchains', () => {
    const p = seatbeltProfile({ home: '/Users/u', workspace: '/Users/u/code/app', temp: ['/private/tmp'], toolchains: ['/Users/u/.nvm'], readOnlyFiles: ['/Users/u/.gitconfig'] })
    expect(p).toContain('(deny file-read-data file-write* (subpath "/Users/u") (subpath "/Volumes"))')
    expect(p).toContain('(allow file-read-data (subpath "/Users/u/.nvm") (literal "/Users/u/.gitconfig"))')
    expect(p).toContain('(allow file-read-data file-write* (subpath "/Users/u/code/app") (subpath "/private/tmp"))')
    // Later rules win in Seatbelt: the openings come after the deny.
    expect(p.indexOf('(deny')).toBeLessThan(p.indexOf('/Users/u/code/app'))
  })

  it('refuses to fence the home itself or a parent of it', () => {
    expect(workspaceIsFenceable('/Users/u', '/Users/u')).toBe(false)
    expect(workspaceIsFenceable('/Users/u', '/Users')).toBe(false)
    expect(workspaceIsFenceable('/Users/u', '/Users/u/code')).toBe(true)
  })

  it('nothing calls it yet', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    for (const f of ['api/mcp/builtin-tools.ts', 'hooks/useCodex.ts', 'hooks/useAgentChat.ts']) {
      expect(readFileSync(resolve(__dirname, '../../..', f), 'utf8')).not.toContain('seatbeltProfile')
    }
  })
})
