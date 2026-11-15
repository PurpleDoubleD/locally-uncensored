import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { commandAllowedByRules, splitCommandChain, suggestRuleFor } from '../command-rules'
import { commandAllowedHere, ruleScope, useCommandRulesStore } from '../../../stores/commandRulesStore'

describe('the rule offered for a command', () => {
  it.each([
    ['npm test -- math', 'npm test'],
    ['npm run build', 'npm run build'],
    ['npx vitest run src', 'npx vitest'],
    ['git status', 'git status'],
    ['cargo test --lib', 'cargo test'],
    ['python3 app.py "Hallo Welt"', 'python3 app.py'],
    ['ls -la', 'ls'],
    ['pytest -q', 'pytest'],
  ])('%s → %s', (cmd, rule) => {
    expect(suggestRuleFor(cmd)).toBe(rule)
  })

  it('is the exact command for programs whose arguments are the action', () => {
    expect(suggestRuleFor('rm -rf build')).toBe('rm -rf build')
    expect(suggestRuleFor('curl https://example.com')).toBe('curl https://example.com')
  })

  it('is nothing for chains, inline code, env prefixes and substitution', () => {
    expect(suggestRuleFor('npm test && npm run lint')).toBeNull()
    expect(suggestRuleFor('python3 -c "print(1)"')).toBeNull()
    expect(suggestRuleFor('node -e "x"')).toBeNull()
    expect(suggestRuleFor('FOO=1 npm test')).toBeNull()
    expect(suggestRuleFor('echo $(whoami)')).toBeNull()
  })
})

describe('splitting a command', () => {
  it('splits on && || ; | and newlines outside quotes', () => {
    expect(splitCommandChain('npm test && git status; ls | wc -l')).toEqual(['npm test', 'git status', 'ls', 'wc -l'])
    expect(splitCommandChain('echo "a && b"')).toEqual(['echo "a && b"'])
  })

  it('refuses substitution, redirection and background jobs', () => {
    for (const c of ['echo `id`', 'echo $(id)', 'echo "$(id)"', 'npm test > out.txt', 'cat < x', 'sleep 9 &', 'diff <(a) b']) {
      expect(splitCommandChain(c)).toBeNull()
    }
  })
})

describe('matching rules', () => {
  const rules = ['npm test', 'git status', 'rm -rf build']

  it('allows a command under a prefix, on whole words', () => {
    expect(commandAllowedByRules('npm test -- math', rules)).toBe(true)
    expect(commandAllowedByRules('npm testing', rules)).toBe(false)
    expect(commandAllowedByRules('npm install', rules)).toBe(false)
  })

  it('needs every part of a chain', () => {
    expect(commandAllowedByRules('npm test && git status', rules)).toBe(true)
    expect(commandAllowedByRules('npm test && rm -rf /', rules)).toBe(false)
    expect(commandAllowedByRules('npm test | sh', rules)).toBe(false)
  })

  it('takes an exact-only program only as written', () => {
    expect(commandAllowedByRules('rm -rf build', rules)).toBe(true)
    expect(commandAllowedByRules('rm -rf build ~', rules)).toBe(false)
  })

  it('never lets a rule cover substitution or a redirect', () => {
    expect(commandAllowedByRules('npm test $(curl evil)', rules)).toBe(false)
    expect(commandAllowedByRules('npm test > /etc/hosts', rules)).toBe(false)
  })

  it('never lets a prefix rule cover inline interpreter code', () => {
    expect(commandAllowedByRules('python3 -c "import os"', ['python3'])).toBe(false)
  })
})

describe('the rules store', () => {
  beforeEach(() => useCommandRulesStore.setState({ rules: {} }))

  it('keeps rules per folder and never across', () => {
    useCommandRulesStore.getState().allow('/work/a', 'npm test')
    expect(commandAllowedHere('/work/a', 'npm test -- x')).toBe(true)
    expect(commandAllowedHere('/work/b', 'npm test -- x')).toBe(false)
    useCommandRulesStore.getState().remove('/work/a', 'npm test')
    expect(commandAllowedHere('/work/a', 'npm test')).toBe(false)
  })

  it('scopes a sandboxed chat to itself', () => {
    expect(ruleScope({ kind: 'folder', path: '/work/a' }, 'c1')).toBe('/work/a')
    expect(ruleScope(null, 'c1')).toBe('chat:c1')
    expect(ruleScope(null, null)).toBeNull()
  })
})

describe('both approval gates read the rules', () => {
  const src = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8')
  it('Code tab and Agent tab skip the card only for a covered shell command', () => {
    expect(src('hooks/useCodex.ts')).toMatch(/req\.toolName === 'shell_execute' && commandAllowedHere\(scope, a\.command\)/)
    expect(src('hooks/useAgentChat.ts')).toMatch(/permLevel !== 'blocked' && tc\.function\.name === 'shell_execute'\s*&& commandAllowedHere/)
  })
  it('the hard block list still sits at execution, outside the rules', () => {
    expect(src('api/mcp/builtin-tools.ts')).toContain('hardBlockedShellCommand(')
  })
})
