/**
 * The two verdicts A8 turned out to need, pulled out of the hook and the two
 * views so they can be tested at all (review S6, S3).
 *
 * The precedence used to be a three-line boolean chain inside a 2000-line
 * send, and "is a run in flight" was written out by hand on each surface, once
 * per surface, differently. That is how the first cut of the fix ended up
 * overwriting a deliberate per-chat workspace and locking the folder picker
 * whenever an unrelated Chat tab was streaming.
 *
 * Run: npx vitest run src/lib/__tests__/codex-workdir.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  CODEX_SANDBOX,
  CODEX_WORKDIR_LOCK_TITLE,
  codexBusyReason,
  codexFallbackLabel,
  resolveCodexWorkDir,
} from '../codex-workdir'

const WINDOWS_PATH = 'C:\\Users\\helpslowlydying\\Documents\\My Projects'

describe('where the Coding Agent works', () => {
  it('the thread wins, it carries what the picker last said', () => {
    expect(resolveCodexWorkDir({
      threadDir: '/thread', workspacePath: '/workspace', storeDir: '/store',
    })).toBe('/thread')
  })

  it("a thread holding the bare '.' is not a pick, so the workspace wins", () => {
    expect(resolveCodexWorkDir({
      threadDir: CODEX_SANDBOX, workspacePath: '/workspace', storeDir: '',
    })).toBe('/workspace')
    // Negative control: a real path in the same slot does win.
    expect(resolveCodexWorkDir({
      threadDir: '/thread', workspacePath: '/workspace', storeDir: '',
    })).toBe('/thread')
  })

  it('an empty thread hands it to the per-chat workspace or the default one', () => {
    expect(resolveCodexWorkDir({
      threadDir: '', workspacePath: '/workspace', storeDir: '',
    })).toBe('/workspace')
  })

  it('nothing anywhere means the per-chat sandbox', () => {
    expect(resolveCodexWorkDir({
      threadDir: '', workspacePath: null, storeDir: '',
    })).toBe(CODEX_SANDBOX)
    // Negative control against null and undefined leaking through as a path.
    expect(resolveCodexWorkDir({
      threadDir: undefined, workspacePath: undefined, storeDir: undefined,
    })).toBe(CODEX_SANDBOX)
  })

  it('the picker still catches a thread that has not been synced yet', () => {
    expect(resolveCodexWorkDir({
      threadDir: '', workspacePath: null, storeDir: WINDOWS_PATH,
    })).toBe(WINDOWS_PATH)
  })

  it('a Windows path passes through untouched', () => {
    const out = resolveCodexWorkDir({
      threadDir: WINDOWS_PATH, workspacePath: null, storeDir: '',
    })
    expect(out).toBe(WINDOWS_PATH)
    expect(out).not.toContain('/')
  })
})

describe('what the empty state is allowed to promise', () => {
  it('names the workspace that actually wins over an empty picker', () => {
    expect(codexFallbackLabel('/home/dave/default-repo')).toBe('/home/dave/default-repo')
  })

  it('and only says the sandbox when nothing else is pinned', () => {
    expect(codexFallbackLabel(null)).toBe('~/agent-workspace')
    expect(codexFallbackLabel('')).toBe('~/agent-workspace')
  })
})

describe('when the working directory is held', () => {
  const free = { sendsInFlight: 0, threads: {}, loop: null }

  it('is free when nothing at all is going on', () => {
    expect(codexBusyReason(free)).toBeNull()
  })

  it('is held from the first synchronous moment of a send', () => {
    expect(codexBusyReason({ ...free, sendsInFlight: 1 })).toBe('run')
  })

  it('is held by a thread the store calls running', () => {
    expect(codexBusyReason({ ...free, threads: { a: { status: 'running' } } })).toBe('run')
  })

  it('is held between two loop passes, where the thread says idle', () => {
    // The dangerous gap: status idle, next pass on a setTimeout. Moving the
    // folder here used to send that pass somewhere else with nobody watching.
    expect(codexBusyReason({
      ...free,
      threads: { a: { status: 'idle' } },
      loop: { conversationId: 'a', pass: 2, cap: 0, task: 't', intervalMs: 30000, nextAt: 0 },
    })).toBe('loop')
  })

  it('an idle thread on its own holds nothing', () => {
    expect(codexBusyReason({ ...free, threads: { a: { status: 'idle' }, b: { status: 'error' } } })).toBeNull()
  })

  it('a finished send releases it, and a double release cannot go negative', () => {
    expect(codexBusyReason({ ...free, sendsInFlight: 0 })).toBeNull()
    expect(codexBusyReason({ ...free, sendsInFlight: -1 })).toBeNull()
  })

  it('says a different sentence for a loop than for a run', () => {
    expect(CODEX_WORKDIR_LOCK_TITLE.run).not.toBe(CODEX_WORKDIR_LOCK_TITLE.loop)
    expect(CODEX_WORKDIR_LOCK_TITLE.loop).toContain('loop')
  })
})
