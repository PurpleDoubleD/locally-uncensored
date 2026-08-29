import { describe, it, expect } from 'vitest'
import { createHermesDisplayFilter } from '../hermes-stream'

function run(deltas: string[]): { shown: string; f: ReturnType<typeof createHermesDisplayFilter> } {
  const f = createHermesDisplayFilter()
  let shown = ''
  for (const d of deltas) shown += f.feed(d)
  return { shown, f }
}

describe('hermes display filter', () => {
  it('passes plain prose through unchanged', () => {
    const { shown, f } = run(['Hello ', 'world', '!'])
    expect(shown + f.flush()).toBe('Hello world!')
  })

  it('swallows a complete tool call and keeps surrounding text', () => {
    const { shown, f } = run([
      'Before. ',
      '<tool_call>{"name":"file_write","arguments":{"path":"a"}}</tool_call>',
      ' After.',
    ])
    expect(shown + f.flush()).toBe('Before.  After.')
  })

  it('swallows a call whose tags are split across many deltas', () => {
    const { shown, f } = run([
      'Text <tool_',
      'call>{"name":"x"',
      ',"arguments":{}}</tool_',
      'call> more',
    ])
    expect(shown + f.flush()).toBe('Text  more')
  })

  it('does not flash any part of the call body mid-stream', () => {
    const f = createHermesDisplayFilter()
    let shown = ''
    shown += f.feed('ok <tool_call>{"name":"secret_tool"')
    expect(shown).toBe('ok ')
    expect(f.inToolCall()).toBe(true)
    shown += f.feed(',"arguments":{}}</tool_call> done')
    expect(shown + f.flush()).toBe('ok  done')
  })

  it('releases a tag-lookalike that never completes', () => {
    const { shown, f } = run(['a < b and <tool', '_x is not a tag'])
    expect(shown + f.flush()).toBe('a < b and <tool_x is not a tag')
  })

  it('flushes a trailing opening-tag prefix as prose at stream end', () => {
    const { shown, f } = run(['ends with <tool_ca'])
    expect(shown).toBe('ends with ')
    expect(f.flush()).toBe('<tool_ca')
  })

  it('keeps an unclosed call swallowed at stream end', () => {
    const { shown, f } = run(['x <tool_call>{"name":"y"'])
    expect(shown).toBe('x ')
    expect(f.flush()).toBe('')
  })

  it('handles several calls in one turn', () => {
    const { shown, f } = run([
      'one <tool_call>{"a":1}</tool_call> two <tool_call>{"b":2}</tool_call> three',
    ])
    expect(shown + f.flush()).toBe('one  two  three')
  })

  it('handles a close tag split exactly at the angle bracket', () => {
    const { shown, f } = run([
      '<tool_call>{"n":"x"}<',
      '/tool_call>after',
    ])
    expect(shown + f.flush()).toBe('after')
  })
})

// ── G35 (David 2026-08-07): the thought streams in the bounded ThinkingBlock
// window on the hermes path too, never full-height into the bubble. The
// splitter routes <think> spans into the thinking channel per delta; the
// turn-end parse on the full raw text stays authoritative.
import { createThinkStreamSplitter } from '../hermes-stream'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

function splitRun(deltas: string[], startInThink = false) {
  const s = createThinkStreamSplitter({ startInThink })
  let prose = ''
  let thinking = ''
  for (const d of deltas) {
    const r = s.feed(d)
    prose += r.prose
    thinking += r.thinking
  }
  const end = s.flush()
  return { prose: prose + end.prose, thinking: thinking + end.thinking, s }
}

describe('think stream splitter', () => {
  it('routes an explicit think span into the thinking channel', () => {
    const r = splitRun(['<think>I should list files</think>', 'Here we go.'])
    expect(r.thinking).toBe('I should list files')
    expect(r.prose).toBe('Here we go.')
  })

  it('R18b witness: the Qwen3 template pre-opens the thought, only the closer arrives', () => {
    // The live screenshot showed the whole thought streaming full-height and
    // ending in a raw </think>. With startInThink everything before the
    // closer belongs to the thinking channel from the first token.
    const r = splitRun(['So after completing step 5, ', 'the next step is 6. </thi', 'nk>Done with step 6.'], true)
    expect(r.thinking).toBe('So after completing step 5, the next step is 6. ')
    expect(r.prose).toBe('Done with step 6.')
  })

  it('handles tags cut across delta boundaries', () => {
    const r = splitRun(['pre <th', 'ink>hidden', ' thought</t', 'hink> post'])
    expect(r.prose).toBe('pre  post')
    expect(r.thinking).toBe('hidden thought')
  })

  it('a stream cut off mid-thought flushes the rest as thinking', () => {
    const r = splitRun(['<think>never closed because the turn died'])
    expect(r.thinking).toBe('never closed because the turn died')
    expect(r.prose).toBe('')
  })

  // ── Negative controls ──────────────────────────────────────────────────

  it('plain prose without tags is untouched, token by token', () => {
    const r = splitRun(['Hello ', 'world, ', 'no thinking here.'])
    expect(r.prose).toBe('Hello world, no thinking here.')
    expect(r.thinking).toBe('')
  })

  it('a lone angle bracket or false prefix stays prose', () => {
    const r = splitRun(['a < b and <thin air'])
    expect(r.prose).toBe('a < b and <thin air')
    expect(r.thinking).toBe('')
  })

  it('without startInThink an orphan closer does not eat the prose', () => {
    // A non-reasoning hermes model never opens a thought; a stray closer in
    // its prose must not reclassify everything before it. The literal tag
    // passes through untouched here — cleaning it up is the job of the
    // end-of-turn parse (splitOrphanCloser), which sees the full text.
    const r = splitRun(['Answer text </think> more text'])
    expect(r.prose).toBe('Answer text </think> more text')
    expect(r.thinking).toBe('')
  })
})

describe('the agent hermes branch is wired through the splitter', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../hooks/useAgentChat.ts'), 'utf8')

  it('display filter output feeds the splitter, gated on keepThinking', () => {
    expect(src).toContain('createThinkStreamSplitter({ startInThink: keepThinking })')
    expect(src).toContain('feedUI(splitter.feed(display.feed(delta)))')
  })

  it('flush order: held prose still passes the splitter before the final flush', () => {
    expect(src).toContain('feedUI(splitter.feed(display.flush()))')
    expect(src).toContain('feedUI(splitter.flush())')
  })

  it('NEGATIVE CONTROL: the authoritative end-of-turn parse still runs on the raw text', () => {
    // The live splitter is UI only. What the turn KEEPS is decided on the
    // full raw text, by the one shared settlement (2.6.7 Denk-Audit moved the
    // hand-written copy of that sequence into lib/thinking-stripper).
    expect(src).toContain('const rawContent = hermesTurn.content')
    expect(src).toContain('settleThinking(turnContent, turnThinking, keepThinking)')
  })

  it('and the same branch keeps the NATIVE reasoning channel too', () => {
    // Loch 2: this branch used to pass streamProviderTurn no thinking
    // callback and never read hermesTurn.thinking, so a backend that parses
    // <think> into reasoning_content by itself lost the whole thought.
    expect(src).toContain('thinkSink.native(full); paintThink()')
    expect(src).toContain('if (hermesTurn.thinking)')
  })
})
