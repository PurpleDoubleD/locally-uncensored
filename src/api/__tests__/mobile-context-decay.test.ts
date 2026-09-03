/**
 * A1 MOBILE: the relay stops carrying a 200 KB read forever.
 *
 * The mobile agent loop pushed every observation into apiMessages at full
 * length, and compactApiMessages always kept the last four messages and
 * counted only `content`. Both halves of that were load-bearing:
 *
 *   - a single big file_read never aged out, so it rode along in every
 *     following request for the rest of the run;
 *   - the four-message floor meant a payload of one huge result was simply
 *     never compacted, whatever the budget said;
 *   - base64 images were invisible to the budget, so a photo turn could sit
 *     ten times over it and compaction saw nothing to do.
 *
 * Ollama then truncated the request from the FRONT, which eats the system
 * prompt and the original task, and the run answered "I'm ready to receive the
 * task" mid-loop. That is the documented mobile task-forgetting.
 *
 * ── 01.09.2026 (T-75): these helpers are now imported, not cut out ──
 *
 * Until today this file read src-tauri/src/commands/remote.rs, found the
 * 2 964-line Rust string the mobile page used to live in, sliced the helper
 * block out of it with two indexOf calls and ran it through `new Function`.
 * It did run the shipped code, which is why it was worth keeping — but it
 * depended on two comment lines inside a Rust literal keeping their exact
 * wording, and nothing said so.
 *
 * The client is real source now (mobile-client/), so the import below is the
 * shipped file. Delete an export from agent-core.js and this stops compiling.
 *
 * Run: npx vitest run src/api/__tests__/mobile-context-decay.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DECAY_RESULT_CHARS, RESTORE_RESULT_CHARS, DECAY_AFTER_ITERATIONS } from '../../lib/context-decay'
import {
  DECAY_AFTER_ITERATIONS as MOBILE_DECAY_AFTER_ITERATIONS,
  DECAY_RESULT_CHARS as MOBILE_DECAY_RESULT_CHARS,
  RESTORE_RESULT_CHARS as MOBILE_RESTORE_RESULT_CHARS,
  capToolResult,
  compactApiMessages,
  decayToolResults,
  dropOldImages,
  isDecayedAt,
  msgChars,
} from '../../../mobile-client/agent-core.js'

interface Msg { role: string; content?: string; images?: string[]; iter?: number }

/** A file out of mobile-client/, i.e. a file the phone really receives. */
const clientSource = (name: string) =>
  readFileSync(resolve(__dirname, '..', '..', '..', 'mobile-client', name), 'utf8')

/**
 * The agent loop, which is what has to CALL all of this.
 *
 * A helper nobody calls proves nothing, and the whole bug was a compaction
 * that could not reach the message that mattered. Reading client.js rather
 * than the whole repository is the same precaution as before: the Rust guards
 * in remote.rs quote these lines, and searching everything let a deleted call
 * match the guard's copy of itself.
 */
const LOOP = clientSource('client.js')
const CORE = clientSource('agent-core.js')

const big = (n: number, fill = 'x') => fill.repeat(n)
const hist = (...msgs: Msg[]) => msgs.map((m) => ({ ...m }))

describe('the relay and the desktop cap by the same numbers', () => {
  it('carries the desktop constants verbatim', () => {
    // Two catalogs of numbers is two behaviours. The desktop module is the
    // source; if it moves, this fails and the relay moves with it.
    expect(MOBILE_DECAY_RESULT_CHARS).toBe(DECAY_RESULT_CHARS)
    expect(MOBILE_RESTORE_RESULT_CHARS).toBe(RESTORE_RESULT_CHARS)
    expect(MOBILE_DECAY_AFTER_ITERATIONS).toBe(DECAY_AFTER_ITERATIONS)
  })

  it('cuts head-heavy and says how much it dropped', () => {
    const out = capToolResult('A'.repeat(3000) + 'B'.repeat(3000), 4000)
    expect(out.length).toBeLessThan(4200)
    expect(out.startsWith('A'.repeat(2640))).toBe(true)
    expect(out.endsWith('B'.repeat(1360))).toBe(true)
    expect(out).toContain('[truncated 2000 chars]')
  })

  it('leaves a result that already fits completely alone', () => {
    const short = 'exit 0'
    expect(capToolResult(short, 4000)).toBe(short)
  })

  it('is idempotent, which is what keeps the prompt prefix still', () => {
    const once = capToolResult(big(200000), 4000)
    const twice = capToolResult(once, 4000)
    expect(twice).toBe(once)
    expect(isDecayedAt(once, 4000)).toBe(true)
    expect(isDecayedAt('plain text', 4000)).toBe(false)
  })
})

describe('a big read stops riding along after two iterations', () => {
  const run = () => hist(
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'read the file and fix the bug' },
    { role: 'assistant', content: '' },
    { role: 'tool', content: big(200000), iter: 1 },
    { role: 'assistant', content: '' },
    { role: 'tool', content: big(5000, 'y'), iter: 2 },
  )

  it('the newest iteration is untouched, every time', () => {
    // The binding rule: the model must never edit against content it can no
    // longer see, and what it is working on is what it just fetched.
    const msgs = run()
    decayToolResults(msgs, 2)
    expect(msgs[3].content!.length).toBe(200000)
    expect(msgs[5].content!.length).toBe(5000)
  })

  it('one step later the older result is capped and the newer one is not', () => {
    const msgs = run()
    decayToolResults(msgs, 3)
    expect(msgs[3].content!.length).toBeLessThan(4200)
    expect(msgs[3].content).toContain('[truncated')
    expect(msgs[5].content!.length).toBe(5000)
  })

  it('a second pass changes nothing, so only one place in the prompt moves per step', () => {
    const msgs = run()
    decayToolResults(msgs, 3)
    const after = msgs.map((m) => m.content)
    decayToolResults(msgs, 3)
    expect(msgs.map((m) => m.content)).toEqual(after)
  })

  it('restored history with no iteration counts as oldest', () => {
    const msgs = hist({ role: 'tool', content: big(50000) })
    decayToolResults(msgs, 1)
    expect(msgs[0].content!.length).toBeLessThan(4200)
  })

  it('negative control: without the decay pass the read stays whole forever', () => {
    const msgs = run()
    // The old behaviour, spelled out: nothing capped it, at any iteration.
    expect(msgs[3].content!.length).toBe(200000)
    decayToolResults(msgs, 99)
    expect(msgs[3].content!.length).toBeLessThan(4200)
  })

  it('only tool results are ever cut', () => {
    const msgs = hist(
      { role: 'user', content: big(50000), iter: 1 },
      { role: 'assistant', content: big(50000), iter: 1 },
    )
    decayToolResults(msgs, 9)
    expect(msgs[0].content!.length).toBe(50000)
    expect(msgs[1].content!.length).toBe(50000)
  })
})

describe('image bytes are part of the budget now', () => {
  it('msgChars counts the base64, which is the whole payload', () => {
    expect(msgChars({ role: 'user', content: 'hi', images: [big(1000), big(500)] })).toBe(1502)
    expect(msgChars({ role: 'user', content: 'hi' })).toBe(2)
  })

  it('only the newest two messages send their pictures again', () => {
    const msgs = hist(
      { role: 'user', content: 'one', images: [big(100)] },
      { role: 'user', content: 'two', images: [big(100), big(100)] },
      { role: 'user', content: 'three', images: [big(100)] },
      { role: 'user', content: 'four', images: [big(100)] },
    )
    dropOldImages(msgs, 2)
    expect(msgs[0].images).toBeUndefined()
    expect(msgs[1].images).toBeUndefined()
    expect(msgs[2].images).toHaveLength(1)
    expect(msgs[3].images).toHaveLength(1)
    // The model is told a picture was there rather than left guessing.
    expect(msgs[0].content).toContain('1 image(s) from an earlier message omitted')
    expect(msgs[1].content).toContain('2 image(s) from an earlier message omitted')
  })

  it('a photo history over budget is now visibly over budget', () => {
    const msgs = hist(
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'look at this', images: [big(40000)] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'and this', images: [big(40000)] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'and this', images: [big(40000)] },
    )
    // Negative control on the old accounting: content alone is a rounding
    // error next to the pictures, so the old total said 40 characters.
    const contentOnly = msgs.reduce((a, m) => a + String(m.content || '').length, 0)
    expect(contentOnly).toBeLessThan(100)
    const out: Msg[] = compactApiMessages(msgs, 24000)
    const kept = out.reduce((a: number, m: Msg) => a + msgChars(m), 0)
    expect(kept).toBeLessThan(90000)
    expect(out[0].role).toBe('system')
  })
})

describe('compaction survives a single result bigger than the whole budget', () => {
  const runaway = () => hist(
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'the task' },
    { role: 'assistant', content: '' },
    { role: 'tool', content: big(200000), iter: 1 },
    { role: 'assistant', content: '' },
    { role: 'tool', content: big(200000, 'z'), iter: 1 },
  )

  it('the payload gets under budget instead of being handed over oversized', () => {
    const out: Msg[] = compactApiMessages(runaway(), 24000)
    const total = out.reduce((a: number, m: Msg) => a + msgChars(m), 0)
    expect(total).toBeLessThanOrEqual(24000)
  })

  it('the system prompt and the task are what survive', () => {
    // The old code returned the four huge messages untouched and Ollama cut
    // the front off, which is exactly these two.
    const out = compactApiMessages(runaway(), 24000)
    expect(out[0].content).toBe('SYSTEM PROMPT')
    expect(out[1].content).toBe('the task')
  })

  it('negative control: the old four-message floor could not do this', () => {
    // Same history, measured the way the old function measured it: it dropped
    // nothing (six messages, floor of four leaves the two big ones) and every
    // byte went to the model.
    const msgs = runaway()
    const oldTotal = msgs.reduce((a, m) => a + String(m.content || '').length, 0)
    expect(oldTotal).toBeGreaterThan(24000 * 16)
  })

  it('a history that fits is returned as it came', () => {
    const msgs = hist(
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', content: 'ok', iter: 1 },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    )
    expect(compactApiMessages(msgs, 24000)).toEqual(msgs)
  })
})

describe('the loop actually calls all of it', () => {
  // A helper nobody calls is a helper that proves nothing, and the whole bug
  // was a compaction that could not reach the message that mattered.
  it('the observation push carries its iteration', () => {
    expect(LOOP).toMatch(/apiMessages\.push\(\{role:'tool', content:obs, iter:iter\}\)/)
    expect(LOOP).toMatch(/apiMessages\.push\(\{role:'tool', content:'Error: '\+errMsg, iter:iter\}\)/)
  })

  it('decay runs before compaction, on every step', () => {
    // Anchored at the start of a line so a commented-out call cannot pass.
    // The first version of this test matched the substring and stayed green
    // with the call disabled, which is the failure mode a guard is for.
    const decayAt = LOOP.search(/\n[ \t]*decayToolResults\(apiMessages, iter\);/)
    const compactAt = LOOP.search(/\n[ \t]*apiMessages = compactApiMessages\(apiMessages, 24000\);/)
    expect(decayAt).toBeGreaterThan(-1)
    expect(compactAt).toBeGreaterThan(decayAt)
  })

  it('the compaction really drops the old images, it does not just define how', () => {
    expect(CORE).toMatch(/\n[ \t]*dropOldImages\(messages, IMAGE_KEEP_RECENT\);/)
    expect(CORE).toMatch(/\n[ \t]*if\(totalChars\(messages\) <= budget\) return messages;/)
  })

  it('a result bigger than the budget is capped rather than handed over whole', () => {
    // The rungs are the last line of defence, and they are easy to delete by
    // accident because nothing in the ordinary path reaches them.
    expect(CORE).toMatch(/var rungs = \[DECAY_RESULT_CHARS, RESTORE_RESULT_CHARS\];/)
  })

  it('restored tool history is capped at the tighter budget when it was never capped', () => {
    expect(LOOP).toMatch(
      /if\(m\.role === 'tool' && !isDecayedAt\(content, DECAY_RESULT_CHARS\)\)\{\s*\n\s*content = capToolResult\(content, RESTORE_RESULT_CHARS\);/,
    )
  })
})
