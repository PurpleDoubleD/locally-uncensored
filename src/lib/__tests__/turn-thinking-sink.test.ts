/**
 * Loch 2 und 3 des Denk-Audits (2.6.7, 2026-08-29).
 *
 * The prompt transport (tools as text, the route every strict template and
 * every tool-less local model takes) had two ways to lose the thought:
 *
 *   2. Both agent loops called streamProviderTurn WITHOUT a thinking
 *      callback and then never read `turn.thinking` either. A backend that
 *      parses <think> into the native reasoning channel by itself, which is
 *      what the built-in engine does, had its whole thought dropped on the
 *      floor: Think button on, answer fine, thinking block empty.
 *   3. The Coding path had no ThinkStreamSplitter at all, so the reasoning
 *      ran full-height into the answer bubble for the length of the turn and
 *      only the end-of-turn parse pulled it back out.
 *
 * Both hooks now feed the SAME sink, which is what this file tests: one place
 * that merges the inline <think> deltas with the cumulative native channel.
 * The wiring itself is pinned by the drift test at the bottom, in the house
 * style of useCodex-streaming.test.ts, because the branch is not reachable
 * without a whole hook harness.
 *
 * Run: npx vitest run src/lib/__tests__/turn-thinking-sink.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createTurnThinkingSink, createThinkStreamSplitter } from '../hermes-stream'

const here = dirname(fileURLToPath(import.meta.url))
const src = (rel: string) => readFileSync(join(here, '..', '..', rel), 'utf8')

describe('the sink keeps both reasoning sources', () => {
  it('inline deltas accumulate', () => {
    const s = createTurnThinkingSink()
    s.inline('first ')
    s.inline('second')
    expect(s.live()).toBe('first second')
  })

  it('the native channel is cumulative, not appended', () => {
    const s = createTurnThinkingSink()
    s.native('let me')
    s.native('let me think')
    expect(s.live()).toBe('let me think')
  })

  it('a native answer does NOT wipe the inline one, which is what the Agent path did', () => {
    const s = createTurnThinkingSink()
    s.inline('from the text stream')
    s.native('from reasoning_content')
    expect(s.live()).toBe('from reasoning_content\n\nfrom the text stream')
  })

  it('and the inline one does not wipe the native one either', () => {
    const s = createTurnThinkingSink()
    s.native('from reasoning_content')
    s.inline('from the text stream')
    expect(s.live()).toBe('from reasoning_content\n\nfrom the text stream')
  })

  it('a repeated literal opener is a marker, not reasoning to read', () => {
    const s = createTurnThinkingSink()
    s.inline('<think>the thought')
    expect(s.live()).toBe('the thought')
  })

  it('negative control: nothing fed means nothing shown, so no empty block opens', () => {
    const s = createTurnThinkingSink()
    s.inline('')
    s.native('')
    expect(s.live()).toBe('')
  })
})

describe('the Qwen3 pre-opened thought reaches the sink and not the answer', () => {
  it('reasoning before the closer goes to the block, the answer stays clean', () => {
    // Exactly the shape the Qwen3 chat templates produce: the opener sits in
    // the PROMPT, so the reply starts mid-thought and only sends the closer.
    const splitter = createThinkStreamSplitter({ startInThink: true })
    const sink = createTurnThinkingSink()
    let prose = ''
    for (const delta of ['Let me ', 'check that.', '</think>', 'The answer is 42.']) {
      const part = splitter.feed(delta)
      sink.inline(part.thinking)
      prose += part.prose
    }
    const rest = splitter.flush()
    sink.inline(rest.thinking)
    prose += rest.prose
    expect(sink.live()).toBe('Let me check that.')
    expect(prose).toBe('The answer is 42.')
  })

  it('negative control: without startInThink the whole thought reads as answer', () => {
    // This is what the Coding path did before the fix, and why the raw
    // reasoning stood in the answer bubble for the length of the turn.
    const splitter = createThinkStreamSplitter()
    const sink = createTurnThinkingSink()
    let prose = ''
    for (const delta of ['Let me ', 'check that.', '</think>', 'The answer is 42.']) {
      const part = splitter.feed(delta)
      sink.inline(part.thinking)
      prose += part.prose
    }
    expect(sink.live()).toBe('')
    expect(prose).toContain('Let me check that.')
  })
})

describe('both agent loops are wired to it, on the prompt transport too', () => {
  const agent = src('hooks/useAgentChat.ts')
  const codex = src('hooks/useCodex.ts')

  it('the Coding path splits the thought out of the live stream', () => {
    expect(codex).toContain('createThinkStreamSplitter({ startInThink: keepThinking })')
  })

  it('both loops merge through the shared sink', () => {
    expect(agent).toContain('createTurnThinkingSink()')
    expect(codex).toContain('createTurnThinkingSink()')
  })

  it('both loops hand streamProviderTurn a thinking callback that feeds it', () => {
    expect(agent).toContain('thinkSink.native(full); paintThink()')
    expect(codex).toContain('thinkSink.native(full); paintThink()')
  })

  it('and both read the native reasoning of the finished prompt-transport turn', () => {
    expect(agent).toContain('if (hermesTurn.thinking)')
    expect(codex).toContain('if (keepThinking && hermesTurn.thinking)')
  })

  // Loch 8: the same branch also threw the SEND side away. It passed
  // `thinking: undefined`, which is not "off", it is "server decides", and
  // the Qwen3 family decides yes. So the button did nothing in either
  // direction on the transport every strict template and every tool-less
  // local model takes, the built-in engine included.
  it('the prompt transport carries the tri-state instead of discarding it', () => {
    for (const src of [agent, codex]) {
      expect(src).toContain('const runHermes = (opts: typeof hermesOpts)')
      expect(src).toContain('hermesTurn = await runHermes(hermesOpts)')
    }
  })

  it('NEGATIVE CONTROL: and still downgrades when the endpoint refuses the knob', () => {
    // Dieselbe Eigenschaft, seit KF-21b in EINER Schreibweise: der Abstieg auf
    // dem Prompt-Transport haengt in beiden Schleifen an `hermesOpts.thinking`,
    // und beide fragen ueber die eine zusammengezogene Stelle
    // (hooks/codex/thinking-downgrade.ts), die die Zusatzbedingung als
    // Parameter traegt. useAgentChat.ts fragte bis dahin an Ort und Stelle.
    // Der Pin nennt darum den vollstaendigen Aufruf samt uebergebener Option
    // und nicht bloss den Namen: `shouldDowngradeThinking(true, …)` waere ein
    // gruener Aufruf der einen Stelle und trotzdem der alte Fehler.
    for (const src of [agent, codex]) {
      expect(src).toContain('shouldDowngradeThinking(hermesOpts.thinking, thinkErr)')
    }
    for (const src of [agent, codex]) {
      expect(src).toContain('runHermes({ ...hermesOpts, thinking: undefined as unknown as boolean })')
    }
  })
})
