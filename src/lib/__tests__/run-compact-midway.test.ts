/**
 * Auto-compact in the middle of a tool run (3.0.7).
 *
 * The run's own model is replaced by a fake that answers like a summariser;
 * everything else (the plan, the cut, the pairs, the ledger, the notice) runs
 * for real.
 *
 * Run: npx vitest run src/lib/__tests__/run-compact-midway.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../compact-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compact-run')>()
  return { ...actual, runCompactSummary: vi.fn() }
})

import { runCompactSummary } from '../compact-run'
import {
  compactRunMidway,
  newRunCompactState,
  planRunCompaction,
  previousStateIn,
  runTurn,
  withLedgerFiles,
  MAX_RUN_FAILURES,
  RUN_COMPACT_NOTICE_PREFIX,
  RUN_MESSAGES_SINCE_COMPACT,
  resultCharsFor,
} from '../run-compact-midway'
import { isToolResult, trimWorkingHistory, type DecayMessage } from '../context-decay'
import {
  COMPACT_OPEN,
  EMPTY_SUMMARY,
  renderCompactSummary,
  type CompactSummary,
} from '../compact-summary'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useRunActivityStore } from '../../stores/runActivityStore'
import { DEFAULT_SETTINGS } from '../constants'
import type { AgentBlock } from '../../types/agent-mode'

const summarise = vi.mocked(runCompactSummary)

const SUMMARY: CompactSummary = {
  ...EMPTY_SUMMARY,
  task: 'Fix the login bug in src/auth.ts.',
  requests: '"fix the login, no refactoring"',
  progress: 'Read src/auth.ts, found the null at line 40.',
  decisions: 'No refactoring.',
  files: 'src/auth.ts read, line 40 is the null check.',
  facts: 'Ticket LU-4711, commit 49795cca7.',
  open: 'Write the test.',
}

type Msg = DecayMessage & { content: string }

/** A run: system, the task, then `steps` native call/result pairs. */
function run(steps: number, resultChars = 3000): Msg[] {
  const out: Msg[] = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'fix the login, no refactoring' },
  ]
  for (let i = 0; i < steps; i++) {
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, function: { name: 'file_read', arguments: JSON.stringify({ path: `src/file${i}.ts` }) } }],
    })
    out.push({ role: 'tool', tool_call_id: `c${i}`, content: `content of file ${i} ` + 'x'.repeat(resultChars) })
  }
  return out
}

/** Same run on the prompt transport: calls as text, results on the user role. */
function hermesRun(steps: number): Msg[] {
  const out: Msg[] = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'fix the login, no refactoring' },
  ]
  for (let i = 0; i < steps; i++) {
    out.push({ role: 'assistant', content: `<tool_call>{"name":"file_read","arguments":{"path":"src/file${i}.ts"}}</tool_call>` })
    out.push({ role: 'user', content: `<tool_response>content of file ${i} ${'x'.repeat(3000)}</tool_response>` })
  }
  return out
}

function seedConversation(): { convId: string; assistantId: string } {
  useChatStore.setState({ conversations: [], activeConversationId: null })
  const convId = useChatStore.getState().createConversation('ollama::qwen3:8b', '')
  useChatStore.getState().addMessage(convId, { id: 'u1', role: 'user', content: 'fix the login', timestamp: 1 })
  useChatStore.getState().addMessage(convId, { id: 'a1', role: 'assistant', content: '', timestamp: 2 })
  return { convId, assistantId: 'a1' }
}

const notices = (convId: string) =>
  (useChatStore.getState().conversations.find((c) => c.id === convId)?.messages ?? [])
    .filter((m) => m.id.startsWith(RUN_COMPACT_NOTICE_PREFIX))

beforeEach(() => {
  summarise.mockReset()
  summarise.mockResolvedValue({ ok: true, summary: { ...SUMMARY }, reason: 'ok' })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useRunActivityStore.setState({ activity: {} })
})

describe('planRunCompaction', () => {
  it('stays quiet while the run is below the threshold', () => {
    const plan = planRunCompaction({ messages: run(3), budgetTokens: 32768, threshold: 0.8, state: newRunCompactState() })
    expect(plan.reason).toBe('below')
  })

  it('is off without a threshold and refuses an unknown window', () => {
    expect(planRunCompaction({ messages: run(30), budgetTokens: 8192, threshold: null, state: newRunCompactState() }).reason).toBe('off')
    expect(planRunCompaction({ messages: run(30), budgetTokens: 0, threshold: 0.8, state: newRunCompactState() }).reason).toBe('no-window')
  })

  it('cuts so that every kept result keeps its call', () => {
    const messages = run(30)
    const plan = planRunCompaction({ messages, budgetTokens: 16384, threshold: 0.74, state: newRunCompactState() })
    expect(plan.reason).toBe('over')
    const kept = messages.slice(plan.keepFrom)
    expect(isToolResult(kept[0])).toBe(false)
    const calls = new Set(kept.flatMap((m) => (Array.isArray(m.tool_calls) ? (m.tool_calls as Array<{ id: string }>).map((c) => c.id) : [])))
    for (const m of kept) if (m.role === 'tool') expect(calls.has(m.tool_call_id!)).toBe(true)
    // The kept part fits its share and leaves real room.
    expect(kept.length).toBeGreaterThanOrEqual(4)
    expect(kept.length).toBeLessThan(messages.length - 2)
  })

  it('pins the person\'s request when the kept steps carry none', () => {
    const messages = run(30)
    const plan = planRunCompaction({ messages, budgetTokens: 16384, threshold: 0.74, state: newRunCompactState() })
    expect(plan.pinIndex).toBe(1)
  })

  it('cools down after a compaction and gives up after repeated failures', () => {
    const messages = run(30)
    const cooling = { ...newRunCompactState(), lastLength: messages.length - (RUN_MESSAGES_SINCE_COMPACT - 1) }
    expect(planRunCompaction({ messages, budgetTokens: 16384, threshold: 0.74, state: cooling }).reason).toBe('cooldown')
    const tired = { ...newRunCompactState(), failures: MAX_RUN_FAILURES }
    expect(planRunCompaction({ messages, budgetTokens: 16384, threshold: 0.74, state: tired }).reason).toBe('gave-up')
  })

  it('never opens the kept part on a Hermes result either', () => {
    const messages = hermesRun(30)
    const plan = planRunCompaction({ messages, budgetTokens: 16384, threshold: 0.74, state: newRunCompactState() })
    expect(plan.reason).toBe('over')
    expect(isToolResult(messages[plan.keepFrom!])).toBe(false)
  })
})

describe('compactRunMidway', () => {
  it('replaces the older steps with the summary and keeps the newest pairs as they were', async () => {
    const { convId, assistantId } = seedConversation()
    const messages = run(30)
    const state = newRunCompactState()
    const out = await compactRunMidway({
      messages, budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b',
      convId, beforeMessageId: assistantId, state,
    })
    expect(out.compacted).toBe(true)
    expect(out.messages[0]).toBe(messages[0])
    // The pinned request carries the summary.
    expect(out.messages[1].role).toBe('user')
    expect(String(out.messages[1].content)).toContain('fix the login, no refactoring')
    expect(String(out.messages[1].content)).toContain(COMPACT_OPEN)
    expect(String(out.messages[1].content)).toContain('LU-4711')
    // The newest steps are the same objects, untouched.
    const tail = out.messages.slice(2)
    expect(tail).toEqual(messages.slice(messages.length - tail.length))
    for (const m of tail) expect(messages).toContain(m)
    expect(out.tokensAfter!).toBeLessThan(out.tokensBefore! / 2)
    expect(state.count).toBe(1)
    // The summary call got the model window, so it is sized to fit.
    expect(summarise.mock.calls[0][0].window).toBe(32768)
  })

  it('leaves a visible notice in front of the answer being written', async () => {
    const { convId, assistantId } = seedConversation()
    await compactRunMidway({
      messages: run(30), budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b',
      convId, beforeMessageId: assistantId, state: newRunCompactState(),
    })
    const all = useChatStore.getState().conversations.find((c) => c.id === convId)!.messages
    const [note] = notices(convId)
    expect(note.role).toBe('system')
    expect(note.notice).toBe('info')
    expect(note.content).toMatch(/^Summarised \d+ earlier step messages of this run/)
    expect(all.findIndex((m) => m.id === note.id)).toBe(all.findIndex((m) => m.id === assistantId) - 1)
  })

  it('with the run\'s block list it adds ONE compaction block instead of a notice (3.0.9)', async () => {
    // David, REA-Test 27.10.: 28.9K/32K, then 17.9K, and nothing to see in the
    // chat. The block lands among the steps of the answer, where the
    // transcript draws it as the line "Compacted, 28.9K → 17.9K" and starts
    // the current view (lib/compact-layers.ts).
    const { convId, assistantId } = seedConversation()
    const blocks: AgentBlock[] = []
    const out = await compactRunMidway({
      messages: run(30), budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b',
      convId, beforeMessageId: assistantId, state: newRunCompactState(),
      onCompacted: (b) => blocks.push(b),
    })
    expect(out.compacted).toBe(true)
    expect(notices(convId)).toEqual([])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].compaction).toEqual({ before: out.tokensBefore, after: out.tokensAfter, replaced: out.replaced })
    // A reader that does not know the field still shows something true.
    expect(blocks[0].phase).toBe('reflection')
    expect(blocks[0].content).toMatch(/^Summarised \d+ earlier step messages of this run/)
  })

  it('a failed compaction adds no block, the warning stays a notice', async () => {
    const { convId, assistantId } = seedConversation()
    summarise.mockResolvedValue({ ok: false, summary: { ...EMPTY_SUMMARY }, reason: 'unusable' })
    const blocks: AgentBlock[] = []
    await compactRunMidway({
      messages: run(30), budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b',
      convId, beforeMessageId: assistantId, state: newRunCompactState(),
      onCompacted: (b) => blocks.push(b),
    })
    expect(blocks).toEqual([])
    expect(notices(convId).map((n) => n.notice)).toEqual(['warn'])
  })

  it('says Compacting while the summary is written and gives the status back after', async () => {
    const { convId, assistantId } = seedConversation()
    useRunActivityStore.getState().setActivity(convId, { label: 'Reading' })
    let during = ''
    summarise.mockImplementationOnce(async () => {
      during = useRunActivityStore.getState().activity[convId]?.label ?? ''
      return { ok: true, summary: { ...SUMMARY }, reason: 'ok' }
    })
    await compactRunMidway({
      messages: run(30), budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b',
      convId, beforeMessageId: assistantId, state: newRunCompactState(),
    })
    expect(during).toBe('Compacting')
    expect(useRunActivityStore.getState().activity[convId]?.label).toBe('Reading')
  })

  it('merges with the record that already rides in the payload', async () => {
    const { convId } = seedConversation()
    const earlier = { ...EMPTY_SUMMARY, task: 'Earlier task', facts: 'Port 5282' }
    const messages = run(30)
    messages[1] = { ...messages[1], content: `${renderCompactSummary(earlier)}\n\n${messages[1].content}` }
    const out = await compactRunMidway({
      messages, budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b', convId, state: newRunCompactState(),
    })
    expect(summarise.mock.calls[0][0].previous?.facts).toBe('Port 5282')
    // One record in the payload, never two nested ones.
    const blocks = out.messages.map((m) => String(m.content).split(COMPACT_OPEN).length - 1).reduce((a, b) => a + b, 0)
    expect(blocks).toBe(1)
  })

  it('keeps the same payload when the summary fails, warns once, and stops after repeated failures', async () => {
    const { convId } = seedConversation()
    summarise.mockResolvedValue({ ok: false, summary: { ...EMPTY_SUMMARY }, reason: 'unusable' })
    const state = newRunCompactState()
    let messages = run(30)
    const first = await compactRunMidway({ messages, budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b', convId, state })
    expect(first.compacted).toBe(false)
    expect(first.messages).toBe(messages)
    messages = [...messages, ...run(5).slice(2)]
    await compactRunMidway({ messages, budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b', convId, state })
    expect(state.failures).toBe(MAX_RUN_FAILURES)
    messages = [...messages, ...run(5).slice(2)]
    const third = await compactRunMidway({ messages, budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b', convId, state })
    expect(third.reason).toBe('gave-up')
    expect(notices(convId).filter((n) => n.notice === 'warn')).toHaveLength(1)
  })

  it('by default never runs below a 32K model window, and always from 32K up', async () => {
    // Owner decision 18.10.2026: "bei 8k nie, bei 32k immer und alles darueber".
    for (const modelWindow of [8192, 16384]) {
      const out = await compactRunMidway({ messages: run(30), budgetTokens: modelWindow, modelWindow, activeModel: 'ollama::qwen3:8b', state: newRunCompactState() })
      expect(out.reason, `${modelWindow}`).toBe('off')
    }
    expect(summarise).not.toHaveBeenCalled()
    for (const modelWindow of [32768, 131072]) {
      const out = await compactRunMidway({ messages: run(30), budgetTokens: 16384, modelWindow, activeModel: 'ollama::qwen3:8b', state: newRunCompactState() })
      expect(out.compacted, `${modelWindow}`).toBe(true)
    }
  })

  it('a fixed threshold the user set runs on a small window too', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoCompactThreshold: 0.6 } })
    const out = await compactRunMidway({ messages: run(30), budgetTokens: 8192, modelWindow: 8192, activeModel: 'ollama::qwen3:8b', state: newRunCompactState() })
    expect(out.compacted).toBe(true)
  })

  it('does nothing when auto-compact is switched off', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoCompact: false } })
    const out = await compactRunMidway({ messages: run(30), budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b', state: newRunCompactState() })
    expect(out.compacted).toBe(false)
    expect(summarise).not.toHaveBeenCalled()
  })

  it('the mechanical trim right after has nothing left to do', async () => {
    const out = await compactRunMidway({ messages: run(30), budgetTokens: 16384, modelWindow: 32768, activeModel: 'ollama::qwen3:8b', state: newRunCompactState() })
    expect(trimWorkingHistory(out.messages, 16384).dropped).toBe(0)
  })
})

describe('what the summariser is shown and what the record keeps', () => {
  it('labels tool output as tool output, also on the user role', () => {
    expect(runTurn({ role: 'user', content: '<tool_response>file body</tool_response>' }).role).toBe('tool result')
    expect(runTurn({ role: 'tool', content: 'file body' }).role).toBe('tool result')
    const call = runTurn({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_read', arguments: '{"path":"src/a.ts"}' } }] })
    expect(call.content).toBe('[tool call] file_read({"path":"src/a.ts"})')
  })

  it('cuts a long result to head and tail', () => {
    const t = runTurn({ role: 'tool', content: 'HEAD' + 'x'.repeat(10_000) + 'TAIL' })
    expect(t.content.startsWith('HEAD')).toBe(true)
    expect(t.content.endsWith('TAIL')).toBe(true)
    expect(t.content.length).toBeLessThan(2200)
  })

  it('shows the summariser the middle of a result when the window has room', () => {
    // Measured 17.10.2026: the one line that mattered sat in the middle of
    // each note, a fixed head and tail cut it out, and the summary made the
    // values up. The share now follows the window.
    const note = 'a'.repeat(2500) + '\nCode: QX-4748-A, value: 13\n' + 'b'.repeat(2500)
    expect(runTurn({ role: 'tool', content: note }, resultCharsFor(32768, 4)).content).toContain('QX-4748-A')
    expect(resultCharsFor(32768, 4)).toBeGreaterThan(note.length)
    expect(resultCharsFor(8192, 40)).toBe(2000)
    expect(resultCharsFor(1_000_000, 1)).toBe(16000)
  })

  it('puts back every file path the summary left out', () => {
    const steps = run(3).slice(2)
    const out = withLedgerFiles({ ...SUMMARY, files: 'src/file0.ts read.' }, steps)
    expect(out.files).toContain('src/file0.ts read.')
    expect(out.files).toContain('file_read: src/file1.ts')
    expect(out.files).toContain('file_read: src/file2.ts')
    expect(out.files.match(/src\/file0\.ts/g)).toHaveLength(1)
  })

  it('finds the newest record in a payload', () => {
    const a = renderCompactSummary({ ...EMPTY_SUMMARY, task: 'old' })
    const b = renderCompactSummary({ ...EMPTY_SUMMARY, task: 'new' })
    expect(previousStateIn([{ role: 'user', content: a }, { role: 'user', content: b }])?.task).toBe('new')
    expect(previousStateIn([{ role: 'user', content: 'nothing' }])).toBeUndefined()
  })
})
