/**
 * Thoughts sit chronologically between the tool calls (G21-2, David live at
 * R19, 2026-08-07): "Die Denkblase ist immer ganz oben ueber den Tool Calls.
 * Es kommen ja immer mehrere Denkblasen, die muessen zwischen den Tool Calls
 * dann genau da kommen, in der richtigen Reihenfolge." The Agent loop now
 * emits each round's thought as its own phase:'thinking' block before that
 * round's calls, and the one top-of-bubble thinking field is cleared so the
 * same thought never renders twice.
 *
 * Run: npx vitest run src/lib/__tests__/thinking-chronology.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// Normalize to LF: a Windows checkout with core.autocrlf=true materializes
// CRLF, and pins that span a line break would fail on line endings alone.
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8').replace(/\r\n/g, '\n')
const agent = read('../../hooks/useAgentChat.ts')
const bubble = read('../../components/chat/MessageBubble.tsx')

describe('the Agent loop emits per-round thinking blocks', () => {
  it('a continuing round writes its thought as a block and clears the top field', () => {
    expect(agent).toContain("phase: 'thinking'")
    const emit = agent.indexOf('// G21-2 (David 2026-08-07)')
    expect(emit).toBeGreaterThan(-1)
    const after = agent.slice(emit, emit + 1400)
    expect(after).toContain("thinkingRef.current = ''")
    expect(after).toContain("updateMessageThinking(convId!, assistantMessage.id, '')")
  })

  it('the closing thought after tool activity lands in the sequence too', () => {
    expect(agent).toContain('executedCallKeys.size > 0 && turnThinking.trim()')
  })

  it('NEGATIVE CONTROL: a run with no tool activity keeps the classic bubble', () => {
    // The final turn falls back to the top-of-bubble field, which the
    // tool-intent hint in MessageBubble reads.
    expect(agent).toContain('thinkingRef.current = turnThinking')
  })

  it('NEGATIVE CONTROL: thoughts are only emitted when thinking is enabled', () => {
    // The 2.6.7 Denk-Audit collapsed the raw setting read here into the one
    // per-step gate the rest of the loop already used, so an 'always'
    // reasoner cannot stream live and then lose its block at the end.
    expect(agent.match(/keepThinking\) \{\n\s+addBlock/g)?.length).toBeGreaterThanOrEqual(1)
    expect(agent).toContain("const keepThinking = agentThinkMode === 'always' || (settings.thinkingEnabled === true && canThinkAgent)")
  })
})

describe('the Codex loop, same contract', () => {
  const codex = read('../../hooks/useCodex.ts')

  it('emits the round thought as a block and clears both fields', () => {
    const emit = codex.indexOf('// G21-2 parity with the Agent loop')
    expect(emit).toBeGreaterThan(-1)
    const after = codex.slice(emit, emit + 1200)
    expect(after).toContain("phase: 'thinking'")
    expect(after).toContain("thinkingContent = ''")
    expect(after).toContain("updateMessageThinking(convId!, assistantMsg.id, '')")
  })

  it('gates on tool work: this round calls tools or earlier ones did', () => {
    expect(codex).toContain('toolCalls.length > 0 || anyToolExecuted')
    expect(codex).toContain('anyToolExecuted = true')
  })

  it('CodexView renders the thought blocks chronologically, band notes included', () => {
    const view = read('../../components/chat/CodexView.tsx')
    expect(view).toContain("(b.phase === 'thinking' && b.content.trim())")
    expect(view).toContain("if (block.phase === 'thinking') {")
    expect(view).toContain('<ThinkingBlock thinking={block.content} />')
  })
})

describe('rendering', () => {
  it('MessageBubble lets thinking blocks through the filter and renders the G14-7 bubble', () => {
    expect(bubble).toContain("(b.phase === 'thinking' && b.content.trim())")
    expect(bubble).toContain("block.phase === 'thinking' ? (")
    expect(bubble).toContain('<ThinkingBlock thinking={block.content} />')
  })

  it('a trailing thought renders as its own collapsed bubble before the answer', () => {
    expect(bubble).toContain('<ThinkingBlock key={block.id} thinking={block.content} />')
  })

  it('NEGATIVE CONTROL: the top-level bubble for plain chat turns is untouched', () => {
    expect(bubble).toContain('<ThinkingBlock thinking={message.thinking} streaming=')
  })
})
