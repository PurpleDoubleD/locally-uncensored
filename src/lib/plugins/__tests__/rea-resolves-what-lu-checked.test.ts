/**
 * marky_7777, 07.11.2026: LU's log showed
 * `WARN ui: [MCP:REA] stderr {"data":"npm warn deprecated prebuild-install@7.1.3 …`.
 *
 * REA's tarball is pinned and checked (commands/plugin_rea.rs), and its own
 * dependencies are exact versions. Theirs are ranges, and npx resolved them on
 * each first start: the start on this Mac on 27.10. pulled @babel/helper-string-parser
 * 8.0.8, fast-uri 3.1.9, jose 6.2.13 and node-abi 3.101.0, all newer than what
 * existed when LU checked REA. prebuild-install comes with Frida's optional
 * package; install scripts are off, so it is fetched and never run.
 *
 * Now every range resolves to what existed on LU's check date, and npm's own
 * warnings are neither printed by REA's npx nor kept as a WARN of the server.
 *
 * Run: npx vitest run src/lib/plugins/__tests__/rea-resolves-what-lu-checked.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { REA_RESOLVE_BEFORE, reaServerConfig, type ReaStatus } from '../rea'
import { isNpmNotice } from '../../../api/mcp/external-client'

const ready: ReaStatus = {
  version: '6.5.0',
  ready: true,
  tarball: '/data/plugins/rea/rea-agents-6.5.0.tgz',
  workDir: '/data/plugins/rea/work',
  path: null,
  node: 'v24.11.0',
  nodeOk: true,
  nodeRange: '22.19 or newer within 22, 24.11 or newer within 24, or 26 and later',
}

describe("REA's dependencies resolve to what LU checked", () => {
  it('npm may pick nothing published after the check date', () => {
    const env = reaServerConfig(ready).env ?? {}
    expect(env.npm_config_before).toBe(REA_RESOLVE_BEFORE)
    // After REA 6.5.0 came out (14.10.2026), before the next one (18.10.2026).
    const t = Date.parse(REA_RESOLVE_BEFORE)
    expect(t).toBeGreaterThan(Date.parse('2026-10-14T12:56:14Z'))
    expect(t).toBeLessThan(Date.parse('2026-10-18T08:12:05Z'))
    expect(env.npm_config_ignore_scripts).toBe('true')
  })

  it('the cutoff names the REA version it was set for', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const rust = readFileSync(resolve(here, '../../../../src-tauri/src/commands/plugin_rea.rs'), 'utf8')
    expect(rust).toContain('pub const REA_VERSION: &str = "6.5.0";')
  })

  it("npm's warnings stay off REA's stderr", () => {
    expect(reaServerConfig(ready).env?.npm_config_loglevel).toBe('error')
  })
})

describe('npm talking on a server stderr is no server warning', () => {
  it('the line from the report', () => {
    expect(isNpmNotice('npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.\n')).toBe(true)
  })

  it('several npm lines, Windows line ends, older casing', () => {
    expect(isNpmNotice('npm WARN deprecated a@1.0.0: x\r\nnpm notice New minor version of npm available\r\n')).toBe(true)
  })

  it('anything else in the chunk keeps it a warning', () => {
    expect(isNpmNotice('npm warn deprecated a@1.0.0: x\nError: Cannot find module frida\n')).toBe(false)
    expect(isNpmNotice('npm error code E404\n')).toBe(false)
    expect(isNpmNotice('{"level":40,"msg":"ghidra not found"}\n')).toBe(false)
    expect(isNpmNotice('\n')).toBe(false)
  })
})
