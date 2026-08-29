/**
 * A `<think>` without its closer must never render as the answer.
 *
 * Found on the installed 2.6.2 Windows build, Coding surface, Ollama with the
 * hermes schema: stopping a run mid-turn left the bubble reading
 * "<think> Okay, let's see. The user is working through a plan to" as if that
 * were the model's reply.
 *
 * The asymmetry is what made it survive. `finalStripThinkingTags` removes an
 * orphan opener only when `keepCanonicalThink` is false, so the bug appears
 * exactly when the user has Thinking ON, which is the default for a model that
 * can think. And the fix cannot simply be "strip it too": with thinking ON that
 * text is real reasoning the user asked to see, so it belongs in the thinking
 * panel rather than in the bin.
 *
 * Run: npx vitest run src/lib/__tests__/unclosed-think.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { splitUnclosedThink, finalStripThinkingTags, settleThinking } from '../thinking-stripper'

const read = (p: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), p), 'utf8')

describe('splitUnclosedThink', () => {
  it('pulls a dangling opener out of the answer', () => {
    const cut = "<think> Okay, let's see. The user is working through a plan to"
    const r = splitUnclosedThink(cut)
    expect(r.content).toBe('')
    expect(r.thinking).toBe(" Okay, let's see. The user is working through a plan to")
  })

  it('keeps the answer that came before the dangling opener', () => {
    const r = splitUnclosedThink('Here is step 4.\n\n<think> now I need to')
    expect(r.content).toBe('Here is step 4.\n\n')
    expect(r.thinking).toBe(' now I need to')
  })

  it('leaves a balanced block alone, that is the other regex job', () => {
    const s = '<think>reasoning</think>the answer'
    expect(splitUnclosedThink(s)).toEqual({ content: s, thinking: '' })
  })

  it('leaves content with no think tag untouched', () => {
    expect(splitUnclosedThink('plain answer')).toEqual({ content: 'plain answer', thinking: '' })
  })

  it('only the LAST opener counts, an earlier balanced one is not re-cut', () => {
    const s = '<think>first</think>answer<think>cut off here'
    const r = splitUnclosedThink(s)
    expect(r.content).toBe('<think>first</think>answer')
    expect(r.thinking).toBe('cut off here')
  })

  it('survives the empty string', () => {
    expect(splitUnclosedThink('')).toEqual({ content: '', thinking: '' })
  })
})

describe('the hole this closes', () => {
  it('NEGATIVE CONTROL: finalStripThinkingTags alone still leaks it with thinking ON', () => {
    const cut = "<think> Okay, let's see"
    // This is the old behaviour and it must stay this way: the function is
    // documented to leave canonical markers to the state machine.
    expect(finalStripThinkingTags(cut, true)).toContain('<think>')
    // With thinking OFF it was never a problem, which is why nobody saw it.
    expect(finalStripThinkingTags(cut, false)).not.toContain('<think>')
  })

  it('and the two together leave nothing behind', () => {
    const cut = "answer so far<think> Okay, let's see"
    const split = splitUnclosedThink(cut)
    expect(finalStripThinkingTags(split.content, true)).toBe('answer so far')
  })
})

// The 2.6.7 Denk-Audit moved the four hand-written copies of this sequence
// into ONE routine, `settleThinking`, because two of the four were missing
// steps. The order inside it is what these used to pin per call site, and
// `settleThinking` is now the only place that can get it wrong.
describe('the settlement runs the splits BEFORE the final strip', () => {
  it('a turn cut off mid-thought lands in the panel, not in the answer', () => {
    const r = settleThinking("answer so far<think> Okay, let's see", '', true)
    expect(r.content).toBe('answer so far')
    expect(r.thinking).toBe(" Okay, let's see")
  })

  it('NEGATIVE CONTROL: thinking OFF drops it instead of showing it', () => {
    const r = settleThinking("answer so far<think> Okay, let's see", '', false)
    expect(r.content).toBe('answer so far')
    expect(r.thinking).toBe('')
  })
})

describe('every path routes through it', () => {
  for (const f of [
    '../../hooks/useCodex.ts',
    '../../hooks/useAgentChat.ts',
    '../../hooks/useChat.ts',
  ]) {
    it(`${f} calls settleThinking`, () => {
      expect(read(f)).toContain('settleThinking(')
    })
  }

  it('and none of them keeps a hand-written copy of the split sequence', () => {
    for (const f of ['../../hooks/useCodex.ts', '../../hooks/useAgentChat.ts', '../../hooks/useChat.ts']) {
      expect(read(f)).not.toContain('splitUnclosedThink(')
      expect(read(f)).not.toContain('splitOrphanCloser(')
    }
  })
})
