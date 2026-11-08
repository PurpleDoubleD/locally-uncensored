/**
 * C44 (Discord 05.11.2026, "Loop guard halted the run: same tool sequence
 * repeated 3×"): a switch in Settings → Agent Permissions turns the loop guard
 * off completely. On by default (owner, 05.11.).
 *
 * Run: npx vitest run src/lib/__tests__/loop-guard-switch.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentLoopGuard } from '../agent-loop-guard'
import { DEFAULT_SETTINGS } from '../constants'
import { findEntry } from '../settings-catalog'

const batch = [{ name: 'file_read', args: '{"path":"a.ts"}' }]
const src = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

/** Feed the same batch until the guard halts or `n` rounds pass. */
function verdicts(guard: AgentLoopGuard, n: number) {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(guard.recordNarration('Let me read the file once more and check the rotation engine.').action)
    out.push(guard.recordBatch(batch).action)
    out.push(guard.recordResults([{ name: 'file_read', failed: true, error: 'boom' }]).action)
  }
  return out
}

describe('C44: the loop guard can be switched off', () => {
  it('on (the default): the same batch over and over is halted', () => {
    expect(verdicts(new AgentLoopGuard(), 8)).toContain('halt')
    expect(verdicts(new AgentLoopGuard({ enabled: true }), 8)).toContain('halt')
  })

  it('off: no detector steers or halts, whatever repeats', () => {
    expect(new Set(verdicts(new AgentLoopGuard({ enabled: false }), 20))).toEqual(new Set(['ok']))
  })

  it('the setting is on by default and in the catalog', () => {
    expect(DEFAULT_SETTINGS.agentLoopGuard).toBe(true)
    expect(findEntry('agentLoopGuard')).toBeTruthy()
  })

  it('both agent loops build their guard from the setting, and the page has the switch', () => {
    for (const p of ['hooks/useAgentChat.ts', 'hooks/useCodex.ts']) {
      expect(src(p)).toContain('new AgentLoopGuard({ enabled: useSettingsStore.getState().settings.agentLoopGuard !== false })')
      expect(src(p)).not.toContain('new AgentLoopGuard()')
    }
    const page = src('components/settings/SettingsPage.tsx')
    expect(page).toMatch(/label="Loop guard"\s+enabled=\{settings\.agentLoopGuard !== false\}/)
  })
})
