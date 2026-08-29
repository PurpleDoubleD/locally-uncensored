/**
 * Loch 4 des Denk-Audits (2.6.7, 2026-08-29): plain chat and group chat never
 * settled the turn.
 *
 * Both ran the char-by-char state machine and nothing else. That machine only
 * ever switches on a literal `<think>`. The Qwen3 chat templates put the
 * OPENER in the prompt, so the reply starts mid-thought and only ever sends
 * the closer, the machine never switches, and with the Think button ON
 * `finalStripThinkingTags` deliberately leaves canonical markers alone. Result
 * on the two surfaces a user reaches first: the whole reasoning plus a raw
 * `</think>` standing in the answer bubble, and an empty thinking block. A
 * thinking model that visibly does not think.
 *
 * The agent and coding loops had been carrying their own copy of the fix since
 * 2.6.6. Four hand-written copies, two of them incomplete, is the shape of bug
 * this audit was sent to end: there is one `settleThinking` now and every path
 * calls it.
 *
 * Run: npx vitest run src/lib/__tests__/settle-thinking-plain-chat.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { settleThinking, finalStripThinkingTags } from '../thinking-stripper'

const read = (p: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), p), 'utf8')

// Read off a real turn: reasoning, closer, answer, no opener anywhere.
const PRE_OPENED = "Okay, the user wants the capital. That is Paris.</think>The capital of France is Paris."

describe('the pre-opened Qwen3 thought', () => {
  it('goes into the block and out of the answer with thinking ON', () => {
    const r = settleThinking(PRE_OPENED, '', true)
    expect(r.content).toBe('The capital of France is Paris.')
    expect(r.thinking).toBe('Okay, the user wants the capital. That is Paris.')
  })

  it('is dropped, not shown, with thinking OFF', () => {
    const r = settleThinking(PRE_OPENED, '', false)
    expect(r.content).toBe('The capital of France is Paris.')
    expect(r.thinking).toBe('')
  })

  it('NEGATIVE CONTROL: the old plain-chat treatment leaks the lot', () => {
    // This is literally what useChat did at chunk.done before the fix, and
    // why the answer bubble carried the reasoning and a raw closer.
    const old = finalStripThinkingTags(PRE_OPENED, true)
    expect(old).toContain('</think>')
    expect(old).toContain('Okay, the user wants the capital')
  })
})

describe('the other shapes the settlement has to cover on the same call', () => {
  it('a balanced block still routes', () => {
    const r = settleThinking('<think>weighing it up</think>Here you go.', '', true)
    expect(r.content).toBe('Here you go.')
    expect(r.thinking).toBe('weighing it up')
  })

  it('native reasoning already collected is kept and the inline one appended', () => {
    const r = settleThinking('<think>and then this</think>Done.', 'from the native channel', true)
    expect(r.thinking).toBe('from the native channel\n\nand then this')
  })

  it('a Gemma channel tag never reaches the answer, in either direction', () => {
    expect(settleThinking('<|channel|>thought hmm</|channel|>Answer.', '', true).content).toBe('Answer.')
    expect(settleThinking('<|channel|>thought hmm</|channel|>Answer.', '', false).content).toBe('Answer.')
  })

  it('NEGATIVE CONTROL: a turn with no reasoning at all is handed back untouched', () => {
    const r = settleThinking('Just an answer.', '', true)
    expect(r.content).toBe('Just an answer.')
    expect(r.thinking).toBe('')
  })
})

describe('plain chat and group chat are wired to it', () => {
  const src = read('../../hooks/useChat.ts')

  it('both turns in useChat settle', () => {
    // One call in runGroupTurn, one in the plain send path.
    expect(src.split('settleThinking(').length - 1).toBe(2)
  })

  it('the group turn settles before the impersonation strip writes the bubble', () => {
    expect(src).toContain('settleThinking(contentAcc, thinkingAcc, keepThinking)')
  })

  it('the plain turn settles the refs the bubble is painted from', () => {
    expect(src).toContain('settleThinking(contentRef.current, thinkingRef.current, keepThinking)')
  })
})
