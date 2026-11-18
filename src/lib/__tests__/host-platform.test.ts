/**
 * The platform line that replaced the desktop_open and app_launch tools
 * (removed 2026-08-06).
 *
 * Those two tools wrapped `open` / `explorer` / `xdg-open`, which is the
 * anti-pattern Anthropic names outright, and which no comparable agent ships:
 * Claude Code, Cline and the rest expose one shell tool. They cost ~478 tokens
 * of every system prompt on a registry that already overflows a 4k-context
 * local model, and they inherited the same confirm gate shell_execute already
 * had, so they bought no safety either.
 *
 * The single real thing they gave a weak model was not having to guess between
 * `open` and `explorer`. These tests pin the cheaper answer: say the OS once,
 * in the prompt.
 *
 * Run: npx vitest run src/lib/__tests__/host-platform.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hostPlatform, platformPromptLine, hostEnvironmentBlock, type HostPlatform } from '../host-platform'

describe('hostPlatform', () => {
  it('recognises the three platforms LU ships on', () => {
    expect(hostPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' })).toBe('macos')
    expect(hostPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe('windows')
    expect(hostPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux)' })).toBe('linux')
  })

  it('reads the user agent when platform is empty, which is what WKWebView does', () => {
    expect(hostPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' })).toBe('macos')
  })

  it('says unknown rather than guessing', () => {
    expect(hostPlatform({})).toBe('unknown')
    expect(hostPlatform({ platform: 'PlayStation 5' })).toBe('unknown')
  })
})

describe('platformPromptLine', () => {
  it('names the OS and the shell shell_execute will really use', () => {
    expect(platformPromptLine('macos')).toMatch(/macOS/)
    expect(platformPromptLine('macos')).toMatch(/bash/)
    expect(platformPromptLine('windows')).toMatch(/Windows/)
    expect(platformPromptLine('windows')).toMatch(/PowerShell/)
    expect(platformPromptLine('linux')).toMatch(/Linux/)
  })

  it('gives the exact open command per platform, which is the whole point', () => {
    expect(platformPromptLine('macos')).toContain('open <path>')
    expect(platformPromptLine('windows')).toContain('Invoke-Item <path>')
    expect(platformPromptLine('linux')).toContain('xdg-open <path>')
  })

  it('keeps the Windows reveal as one argument, comma included', () => {
    // Passing "/select," and the path separately makes explorer ignore the path
    // and open Documents. The prompt has to show the joined form.
    expect(platformPromptLine('windows')).toContain('explorer "/select,<path>"')
    expect(platformPromptLine('windows')).toMatch(/one argument/i)
  })

  it('tells the truth about Linux having no reveal', () => {
    expect(platformPromptLine('linux')).toMatch(/no reveal/i)
    expect(platformPromptLine('linux')).not.toContain('/select,')
  })

  it('names how to start an application everywhere it can', () => {
    expect(platformPromptLine('macos')).toContain('open -a')
    expect(platformPromptLine('windows')).toContain('Start-Process')
    expect(platformPromptLine('linux')).toContain('gtk-launch')
  })

  it('invents nothing on an unknown platform', () => {
    const line = platformPromptLine('unknown')
    expect(line).toMatch(/unknown/i)
    // system_info is retired (2.6.6); the shell itself is the probe now.
    expect(line).toMatch(/uname -s/)
    // A wrong incantation is worse than none.
    for (const cmd of ['open ', 'explorer', 'xdg-open', 'Invoke-Item', 'gtk-launch']) {
      expect(line).not.toContain(cmd)
    }
  })

  it('stays far cheaper than the tools it replaced', () => {
    // The two tool definitions were ~1914 characters, roughly 478 tokens, in
    // EVERY system prompt. The budget that matters is MythoMax at 4k. If this
    // line ever grows past a few hundred characters the trade stops paying.
    for (const p of ['macos', 'windows', 'linux', 'unknown'] as HostPlatform[]) {
      expect(platformPromptLine(p).length).toBeLessThan(400)
    }
  })
})

describe('the tools really are gone', () => {
  // A registry entry is cheap to add back by reflex. This states the decision
  // where someone re-adding it would trip over it.
  const src = resolve(__dirname, '..', '..')
  const read = (...p: string[]) => readFileSync(resolve(src, ...p), 'utf8')

  it('no tool definition or executor is left behind', () => {
    const tools = read('api', 'mcp', 'builtin-tools.ts')
    expect(tools).not.toMatch(/name: 'desktop_open'/)
    expect(tools).not.toMatch(/name: 'app_launch'/)
    expect(tools).not.toMatch(/executeDesktopOpen|executeAppLaunch/)
  })

  it('shell_execute is the documented way to open something', () => {
    // The A6 diet shortened the sentence; what has to survive is that the
    // description still names opening files/folders/apps as shell work, so
    // nobody re-adds a tool for it.
    const tools = read('api', 'mcp', 'builtin-tools.ts')
    expect(tools).toMatch(/open(ing)? (things on the desktop|files, folders or apps)/)
  })

  it('the agent prompt states the platform instead of spending a call on it', () => {
    // There is no render harness in this repo, so the prompt is guarded at the
    // source, like DownloadBadge-autoclose.test.ts does.
    // 2.6.6 plan A5 split the block in two: the platform sentence is stable
    // and stays where it was, the clock is volatile and moved to the very end
    // of the prompt so a prefix cache can still match everything in front of
    // it. Both halves still have to be there.
    const agent = read('hooks', 'useAgentChat.ts')
    expect(agent).toMatch(/platformPromptLine\(\)/)
    // 3.1.2 (A39): through the switch "Share date and time with the model".
    expect(agent).toMatch(/agentClockLine\(\)/)
    expect(agent).toMatch(/OS, clock and timezone are stated in this prompt/)
    // Codex pays for the block too now (it never had the platform sentence).
    const codex = read('hooks', 'useCodex.ts')
    expect(codex).toMatch(/platformPromptLine\(\)/)
    expect(codex).toMatch(/agentClockLine\(\)/)
  })
})

describe('hostEnvironmentBlock', () => {
  it('carries platform sentence, clock and timezone in one block', () => {
    const fixed = new Date('2026-08-21T12:00:00Z')
    const block = hostEnvironmentBlock('macos', fixed)
    expect(block).toContain('macOS')
    expect(block).toContain('2026')
    expect(block).toMatch(/Trust this line/)
  })

  it('replaces the clock tool, so it must name the date of the run', () => {
    const fixed = new Date('2026-08-21T12:00:00Z')
    expect(hostEnvironmentBlock('linux', fixed)).toMatch(/August 2026/)
  })
})
