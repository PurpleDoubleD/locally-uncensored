/**
 * Smoke tests for the Codex loop-detector (Bug #5 hotfix, 2026-04-19).
 *
 * Small / 3B models (qwen2.5-coder:3b, llama3.2:1b) often get stuck
 * repeating the same file_write + shell_execute batch because a test
 * fails and they "fix" it by rewriting the same file. The loop detector
 * aborts with a clear message when the same batch signature appears
 * twice in a row.
 *
 * These tests read the actual source so we catch accidental removal
 * of the detector during refactors.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const src = readFileSync(join(__dirname, '../useCodex.ts'), 'utf8')

describe('useCodex loop-detector (Bug #5)', () => {
  it('declares prevBatchSig tracking variable', () => {
    expect(src).toContain('prevBatchSig')
  })

  it('declares sameBatchRepeats counter', () => {
    expect(src).toContain('sameBatchRepeats')
  })

  it('computes batch signature from tool name + arguments, sorted', () => {
    expect(src).toContain('batchSig')
    expect(src).toContain("tc.function.name + ':' + JSON.stringify(tc.function.arguments)")
    expect(src).toContain('.sort()')
  })

  it('halts after 2 identical repeats (total 3 matching batches)', () => {
    // sameBatchRepeats >= 2 with prevBatchSig === batchSig means 3 batches in a row
    expect(src).toMatch(/sameBatchRepeats\s*>=\s*2/)
  })

  it('emits a user-visible halt message mentioning model size', () => {
    expect(src).toMatch(/same tool sequence repeated/)
    expect(src).toMatch(/larger model/i)
  })

  it('resets the repeat counter when the batch changes', () => {
    expect(src).toContain('sameBatchRepeats = 0')
  })

  it('checks batch signature AFTER tool calls are collected but BEFORE executing', () => {
    // The detector sits between "toolCalls.length === 0 break" and the
    // batch-building for-loop — so it catches the repeat before we burn
    // an execution slot and another HTTP round-trip.
    const idxCheck = src.indexOf('batchSig = toolCalls')
    const idxExec = src.indexOf('budget.addToolCalls(toolCalls.length)')
    expect(idxCheck).toBeGreaterThan(0)
    expect(idxExec).toBeGreaterThan(idxCheck)
  })
})

describe('useChat stop fast-path (Bug #6)', () => {
  const chatSrc = readFileSync(join(__dirname, '../useChat.ts'), 'utf8')

  it('checks abort.signal.aborted inside the chunk for-await loop', () => {
    // The fast-path must live inside the for-await so Stop feels instant
    // during long thinking chains (Gemma 4, QwQ).
    expect(chatSrc).toContain('for await (const chunk of stream)')
    expect(chatSrc).toContain('if (abort.signal.aborted) break')
    // Must appear AFTER the for-await opens (inside the body, not before).
    const idxLoop = chatSrc.indexOf('for await (const chunk of stream)')
    const idxAbort = chatSrc.indexOf('if (abort.signal.aborted) break')
    expect(idxAbort).toBeGreaterThan(idxLoop)
    // And within reasonable distance (not 2000 chars away).
    expect(idxAbort - idxLoop).toBeLessThan(500)
  })
})

describe('useCodex stream reader abort fast-path (Bug #6)', () => {
  // The streaming helper moved out of useCodex.ts into the shared
  // ollama-stream-tools module so the regular Agent can use it too.
  // The fast-path now lives there.
  const streamSrc = readFileSync(
    join(__dirname, '../../lib/ollama-stream-tools.ts'),
    'utf8',
  )

  it('cancels the reader when signal.aborted inside the NDJSON while loop', () => {
    expect(streamSrc).toMatch(/options\.signal\?\.aborted/)
    expect(streamSrc).toMatch(/reader\.cancel/)
  })
})
