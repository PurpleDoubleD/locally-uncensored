/**
 * CA, 14.11.2026, bench AG10: a model that could not find a fact in its memory
 * spent 32 minutes on `find / -maxdepth 6`, `ls /Users/<name>`, greps through
 * ~/Library/Application Support and `ps aux`, with shell timeouts of 600 s,
 * and ended with no answer. Three fixes, pinned here:
 *   1. the shell gate (lib/shell-scope.ts),
 *   2. the timeout cap,
 *   3. the search spiral in the loop guard (detector 9).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  cappedShellTimeout, outsideRefusal, scanCodePaths, scanShellPaths, shellReachOutside,
  SHELL_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MAX_MS, TEST_RUN_TIMEOUT_MAX_MS,
} from '../shell-scope'
import { AgentLoopGuard, huntHaltAnswer, isHuntCall } from '../agent-loop-guard'

/** The backend jail, as the tool asks it: inside /work/app or not. */
const jail = async (p: string) => {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  const full = '/' + parts.join('/')
  return !(full === '/work/app' || full.startsWith('/work/app/'))
}

describe('the shell gate', () => {
  it('lets the folder be the folder', async () => {
    for (const c of [
      'ls -la', 'find . -name "*.json" 2>/dev/null', 'cat src/a.ts | grep x', 'node --test',
      'grep -r "/api/v1" src', 'python3 - < script.py', '/usr/bin/env python3 run.py',
      'cat /work/app/notes.md', 'git log HEAD~1', 'echo hi > /tmp/x', 'curl https://example.com/a/b',
    ]) {
      expect(await shellReachOutside(c, jail), c).toBeNull()
    }
  })

  it('refuses the home folder, the disk root and paths outside, as AG10 typed them', async () => {
    const cases: Array<[string, string]> = [
      ["find / -maxdepth 6 -iname '*.json' -path '*memor*' 2>/dev/null", 'root'],
      ['ls -la /Users/someone/ 2>&1 | head -50', 'outside'],
      ["grep -rliE 'editor|commit' ~/Library/Application\\ Support/lu-vault", 'home'],
      ['ls -la ~/.lu ~/.config/lu ~/lu 2>/dev/null', 'home'],
      ['echo HOME=$HOME; whoami', 'home'],
      ['cat ../../.ssh/id_rsa', 'outside'],
      ['cat "/etc/hosts"', 'outside'],
      ['dir %USERPROFILE%\\Documents', 'home'],
      ['type C:\\Windows\\win.ini', 'outside'],
    ]
    for (const [c, why] of cases) {
      const r = await shellReachOutside(c, jail)
      expect(r?.why, c).toBe(why)
    }
  })

  it('a relative path from a subfolder is judged from there', async () => {
    expect(await shellReachOutside('cat ../README.md', jail, '/work/app/src')).toBeNull()
    expect((await shellReachOutside('cat ../../x', jail, '/work/app/src'))?.why).toBe('outside')
  })

  it('a quoted pattern is not taken for a path, a quoted system path is', () => {
    expect(scanShellPaths('grep -r "/api/v1" .').check).toEqual([])
    expect(scanShellPaths("grep x '/Users/a/b'").check).toEqual(['/Users/a/b'])
  })

  it('the refusal tells the model to stop looking, and where to allow more', () => {
    const text = outsideRefusal({ path: '/', why: 'root' })
    expect(text).toMatch(/^Refused:/)
    expect(text).toMatch(/Settings → Agent/)
    expect(text).toMatch(/stop searching and say so/)
  })

  it('code_execute: the home folder and system paths typed into the code', () => {
    expect(scanCodePaths("import os\nprint(os.listdir(os.path.expanduser('~')))")?.why).toBe('home')
    expect(scanCodePaths("from pathlib import Path\nPath.home()")?.why).toBe('home')
    expect(scanCodePaths("open('/etc/passwd').read()")?.why).toBe('outside')
    expect(scanCodePaths("open('data/a.json').read()")).toBeNull()
    expect(scanCodePaths("open('/tmp/out.txt','w')")).toBeNull()
  })

  it('every way into the shell asks the gate, unless the user allowed more', () => {
    const src = readFileSync('src/api/mcp/builtin-tools.ts', 'utf8')
    const fn = (name: string) => { const a = src.indexOf(`async function ${name}(`); return src.slice(a, src.indexOf('\n}\n', a)) }
    const fg = fn('executeShellExecute')
    // Before the background switch, so `background: true` is no way around it.
    expect(fg.indexOf('outsideFolderRefusal(command')).toBeGreaterThan(0)
    expect(fg.indexOf('outsideFolderRefusal(command')).toBeLessThan(fg.indexOf('if (args.background)'))
    expect(fn('executeShellExecuteBg')).toMatch(/outsideFolderRefusal\(command/)
    expect(fn('executeCodeExecute')).toMatch(/scanCodePaths\(/)
    expect(fn('outsideFolderRefusal')).toMatch(/agentShellOutsideFolder === true/)
    // "Outside" is the backend jail's own answer, the one the file tools get.
    expect(fn('outsideFolderRefusal')).toMatch(/fs_info/)
  })

  it('the switch is off unless the user turns it on, and the agent cannot turn it on', async () => {
    const page = readFileSync('src/components/settings/SettingsPage.tsx', 'utf8')
    expect(page).toMatch(/enabled=\{settings\.agentShellOutsideFolder === true\}/)
    const { lockedRule } = await import('../settings-catalog')
    expect(lockedRule('agentShellOutsideFolder')).toBeTruthy()
  })

  it('the phone remote runs the same gate in the desktop, always on', () => {
    const remote = readFileSync('src-tauri/src/commands/remote.rs', 'utf8')
    expect(remote.match(/crate::shell_scope::refusal\(&command, &root, &here\)/g)?.length).toBe(2)
    expect(remote).toMatch(/crate::shell_scope::code_refusal\(&code\)/)
    expect(remote).toMatch(/crate::shell_scope::capped_timeout\(/)
  })
})

describe('the timeout cap', () => {
  it('600 s asked is 120 s given; a test run may have 300 s, never more', () => {
    expect(cappedShellTimeout(600_000, SHELL_TIMEOUT_DEFAULT_MS)).toBe(SHELL_TIMEOUT_MAX_MS)
    expect(cappedShellTimeout(undefined, SHELL_TIMEOUT_DEFAULT_MS)).toBe(120_000)
    expect(cappedShellTimeout(5_000, SHELL_TIMEOUT_DEFAULT_MS)).toBe(5_000)
    expect(cappedShellTimeout(undefined, 300_000)).toBe(300_000)
    expect(cappedShellTimeout(3_600_000, 300_000)).toBe(TEST_RUN_TIMEOUT_MAX_MS)
  })
})

describe('detector 9: the search spiral', () => {
  const call = (name: string, args: Record<string, unknown>) => ({ name, args: JSON.stringify(args) })
  const AG10 = [
    ...['editor', 'commit message language', 'commit', 'Editor Präferenz', 'Sprache', 'VS Code', 'German', 'git', 'workflow']
      .map((q) => call('memory', { action: 'search', query: q })),
    call('file_list', { path: '.' }),
    call('shell_execute', { command: "pwd; echo '---'; ls -la; git config --list" }),
    call('shell_execute', { command: "find ~/Library/Application\\ Support -maxdepth 3 -iname '*memor*' 2>/dev/null" }),
    call('memory', { action: 'search', query: 'commit messages' }),
    call('memory', { action: 'search', query: 'favourite editor' }),
    call('shell_execute', { command: "grep -rliE 'editor|commit' ~/Library/Application\\ Support/lu-vault" }),
    call('shell_execute', { command: "find / -maxdepth 6 -iname '*.json' -path '*memor*' 2>/dev/null | grep -v node" }),
    call('shell_execute', { command: 'ls -la ~/Library/Application\\ Support/Locally\\ Uncensored\\ ca/' }),
    call('shell_execute', { command: "find ~/Desktop -maxdepth 4 -iname '*memor*'" }),
    call('shell_execute', { command: 'ls -la /Users/someone/ 2>&1 | head -50' }),
    call('shell_execute', { command: "echo HOME=$HOME; whoami; ps aux | grep -iE 'lu|labs'" }),
  ]

  it('the AG10 run steers at twelve lookups and ends at twenty, with an honest answer', () => {
    const g = new AgentLoopGuard()
    const verdicts = AG10.map((c) => g.recordBatch([c]))
    const steerAt = verdicts.findIndex((v) => v.action === 'steer' && /searched 12 times/.test(v.message))
    const haltAt = verdicts.findIndex((v) => v.action === 'halt')
    expect(steerAt).toBe(11)
    expect(haltAt).toBe(19)
    const halt = verdicts[haltAt] as { action: 'halt'; reason: string; answer?: string }
    expect(halt.answer).toBe(huntHaltAnswer(20))
    expect(halt.answer).toMatch(/^I could not find it\./)
  })

  it('reading what a search found neither counts nor resets', () => {
    const g = new AgentLoopGuard()
    for (let i = 0; i < 11; i++) {
      g.recordBatch([call('file_search', { path: '.', pattern: `p${i}` })])
      g.recordBatch([call('file_read', { path: `f${i}.ts` })])
    }
    const v = g.recordBatch([call('file_search', { path: '.', pattern: 'p11' })])
    expect(v.action).toBe('steer')
  })

  it('an edit or a test run in between is progress: a codebase explored and changed never trips it', () => {
    const g = new AgentLoopGuard()
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 9; i++) expect(g.recordBatch([call('file_search', { path: 'src', pattern: `r${round}n${i}` })]).action).toBe('ok')
      expect(g.recordBatch([call('file_edit', { path: `src/m${round}.ts`, old_string: 'a', new_string: 'b' })]).action).toBe('ok')
      expect(g.recordBatch([call('shell_execute', { command: 'npm test' })]).action).toBe('ok')
    }
  })

  it('what counts as only looking', () => {
    expect(isHuntCall('memory', JSON.stringify({ action: 'search', query: 'x' }))).toBe(true)
    expect(isHuntCall('memory', JSON.stringify({ action: 'add', content: 'x' }))).toBe(false)
    expect(isHuntCall('shell_execute', JSON.stringify({ command: 'find . -name x 2>/dev/null' }))).toBe(true)
    expect(isHuntCall('shell_execute', JSON.stringify({ command: 'ls > list.txt' }))).toBe(false)
    expect(isHuntCall('shell_execute', JSON.stringify({ command: 'npm test' }))).toBe(false)
    expect(isHuntCall('file_write', JSON.stringify({ path: 'a', content: 'b' }))).toBe(false)
  })

  it('all three loops end a spiral with its answer instead of "the model is looping"', () => {
    expect(readFileSync('src/hooks/useAgentChat.ts', 'utf8')).toMatch(/batchVerdict\.answer\s*\n?\s*\/\/[^\n]*\n\s*\? batchVerdict\.answer/)
    expect(readFileSync('src/hooks/useCodex.ts', 'utf8')).toMatch(/const msg = batchVerdict\.answer/)
    expect(readFileSync('src/mobile/remote/remoteAgent.ts', 'utf8')).toMatch(/if \(verdict\.answer\) return finish\('done'/)
  })
})
