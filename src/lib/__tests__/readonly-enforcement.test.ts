/**
 * Read-only turns must be enforced where the tools RUN, not only where they are
 * offered.
 *
 * Live on the ship exe, 2026-07-25: /plan is read-only, every one of its six
 * requests carried a catalog of file_read / file_list / file_search only, and
 * it still created helper.js on disk. The loose-parse fallback lifts a call the
 * model wrote as prose and hands the name to toolRegistry.execute, which
 * resolves by name and never asks whether this turn was allowed to offer it.
 * Code Review Mode carried the same hole and made the same promise.
 *
 * These tests pin the guard itself (the filter both hooks apply to a batch) and
 * assert the source still contains it, so the belt cannot quietly come off
 * again.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MUTATING_TOOLS, allowedInReadOnlyTurn } from '../mutating-tools'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')

type Call = { function: { name: string } }
/** The guard both hooks apply before a batch executes. Since the 2.6.6 merge
 * it keeps shell_execute (the executor gates by command); everything else
 * mutating is still dropped by name. */
const applyGuard = (calls: Call[], readOnly: boolean) =>
  readOnly ? calls.filter((c) => allowedInReadOnlyTurn(c.function?.name ?? '')) : calls

const call = (name: string): Call => ({ function: { name } })

describe('read-only batch guard', () => {
  it('drops a write the model smuggled in as text', () => {
    const batch = [call('file_read'), call('file_write'), call('file_search')]
    expect(applyGuard(batch, true).map((c) => c.function.name)).toEqual(['file_read', 'file_search'])
  })

  it('drops every mutating tool except the command-gated shell', () => {
    const batch = [...MUTATING_TOOLS].map(call)
    // shell_execute survives the name strip on purpose: it carries the git
    // inspectors now, and its executor refuses non-inspection commands.
    expect(applyGuard(batch, true).map((c) => c.function.name)).toEqual(['shell_execute'])
  })

  it('leaves the read tools alone', () => {
    const reads = ['file_read', 'file_list', 'file_search'].map(call)
    expect(applyGuard(reads, true)).toHaveLength(reads.length)
  })

  it('changes nothing on a normal turn', () => {
    const batch = [call('file_write'), call('shell_execute')]
    expect(applyGuard(batch, false)).toHaveLength(2)
  })

  it('git inspection stays reachable: shell_execute survives the strip', () => {
    // A reviewer still has to be able to look at the diff it is reviewing,
    // and since the merge that look goes through shell_execute.
    expect(allowedInReadOnlyTurn('shell_execute')).toBe(true)
    for (const t of ['file_read', 'file_list', 'file_search']) {
      expect(MUTATING_TOOLS.has(t), `${t} must stay available`).toBe(false)
    }
  })

  it('the tools that can actually change something are all listed', () => {
    for (const t of ['file_write', 'file_edit', 'shell_execute', 'image_generate', 'video_generate', 'run_workflow', 'delegate_task', 'screenshot']) {
      expect(MUTATING_TOOLS.has(t), `${t} must be listed`).toBe(true)
    }
  })
})

describe('both hooks still carry the guard', () => {
  it('useCodex filters the batch, not just the catalog', () => {
    const src = read('../../hooks/useCodex.ts')
    // Since 2.6.6 C1 the three read-only reasons are one flag, and the runtime
    // filter hangs on the PERSISTENT conversation mode as well as the slash
    // turn, so Plan mode is enforced on every step and not only when a
    // read-only command started the turn.
    expect(src).toContain("const effectiveReadOnly = settings.codexReviewMode === true || readOnlyTurn || codexMode === 'plan'")
    expect(src).toContain('if (effectiveReadOnly) {')
    expect(src).toContain('toolCalls = toolCalls.filter((tc) => allowedInReadOnlyTurn(tc.function?.name ?? \'\'))')
  })

  it('useAgentChat filters the batch too', () => {
    const src = read('../../hooks/useAgentChat.ts')
    expect(src).toContain('if (opts?.readOnly) {')
    expect(src).toContain('toolCalls = toolCalls.filter((tc) => allowedInReadOnlyTurn(tc.function?.name ?? \'\'))')
  })

  it('the blocklist has exactly one definition', () => {
    // It lived inline in useCodex, which is part of why Agent mode never had it.
    for (const f of ['../../hooks/useCodex.ts', '../../hooks/useAgentChat.ts']) {
      expect(read(f)).toContain("from '../lib/mutating-tools'")
    }
  })
})

describe('/loop actually loops', () => {
  // David, 2026-07-25: a loop is not a deadline. `/loop 30s <task>` means come
  // back every 30 seconds and check again, so the agent cannot forget a piece
  // and cannot get away with an early "done". An earlier build read the number
  // as a time limit and Qwen3-32B tried to cram the whole task into 30 seconds.
  it('derives the interval from the command, not from a setting', () => {
    const src = read('../../hooks/useCodex.ts')
    expect(src).toContain("slash?.command.name === 'loop'")
    expect(src).toContain('parseLoopSpec(slash.args)')
  })

  it('starts the NEXT pass after the interval instead of killing the run', () => {
    const src = read('../../hooks/useCodex.ts')
    // The handle is module-scoped since audit A3 — a hook ref died with the
    // unmounted Code view, so stopCodex could not reach a pending pass.
    expect(src).toContain('let codexLoopTimer:')
    expect(src).toContain('codexLoopTimer = setTimeout(fireLoopPass, loopState.intervalMs)')
    expect(src).toContain('buildLoopRecheck(loopState.task, nextPass)')
  })

  it('stops on the done marker or on a cap the user set, and NOTHING else', () => {
    const src = read('../../hooks/useCodex.ts')
    expect(src).toContain('loopPassSaysDone(')
    // The cap comes from settings and 0 means unlimited (David 2026-07-25:
    // "loop darf keine maximal loops erhalten").
    expect(src).toContain('settings.loopMaxPasses ?? 0')
    expect(src).toContain('cap > 0 && nextPass > cap')
    // No built-in ceilings may creep back in.
    expect(src).not.toContain('MAX_LOOP_PASSES')
    expect(src).not.toContain('MAX_LOOP_TOTAL_MS')
  })

  it('runs in Agent mode too, not only in Code', () => {
    const src = read('../../hooks/useAgentChat.ts')
    expect(src).toContain('buildLoopRecheck(loopState.task, nextPass)')
    expect(src).toContain('settings.loopMaxPasses ?? 0')
    // And the chat router has to seed pass 1, or nothing ever loops there.
    expect(read('../../hooks/useChat.ts')).toContain("slash.command.name === 'loop'")
  })

  it('a running loop is visible and stoppable', () => {
    // Unlimited is only defensible if the user can see it and stop it.
    for (const f of ['../../hooks/useCodex.ts', '../../hooks/useAgentChat.ts']) {
      expect(read(f)).toContain('useAgentLoopStore.getState().start(')
      expect(read(f)).toContain('useAgentLoopStore.getState().clear()')
    }
  })

  it('stop cancels a pass that is waiting out its interval', () => {
    // Otherwise the run the user just killed comes back by itself.
    const src = read('../../hooks/useCodex.ts')
    const stopIdx = src.indexOf('const stopCodex = useCallback(')
    expect(stopIdx).toBeGreaterThan(0)
    const stopBody = src.slice(stopIdx, stopIdx + 900)
    expect(stopBody).toContain('clearTimeout(codexLoopTimer)')
    // The stop is recorded MODULE-side, keyed by conversation (audit M1): a
    // hook-instance ref was invisible to the finally of a pass a previous
    // instance had started, so that finally re-armed the loop the user killed.
    expect(stopBody).toContain('stopRun(stoppedConvId)')
    // And it reaches a run started by a PREVIOUS hook instance (audit A2).
    expect(stopBody).toContain('abortConversation(')
  })

})
