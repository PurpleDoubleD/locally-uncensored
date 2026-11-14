/**
 * Smoke tests for the Codex loop-detector wiring.
 *
 * Bug #5 (2026-04-19) added a consecutive-batch detector; 2.5.10 replaced it
 * with the shared AgentLoopGuard (windowed repeats, identical-read counting,
 * narration repeats — src/lib/agent-loop-guard.ts, behaviour unit-tested in
 * src/lib/__tests__/agent-loop-guard.test.ts) after Morgan's live 5-minute
 * file_read loop (2026-07-26) sailed straight past the consecutive rule.
 *
 * These tests read the actual source so we catch accidental removal of the
 * guard WIRING during refactors; the guard's logic has its own unit tests.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const src = readFileSync(join(__dirname, '../useCodex.ts'), 'utf8')

describe('useCodex loop-detector (Bug #5 → AgentLoopGuard)', () => {
  it('instantiates the shared AgentLoopGuard for the run', () => {
    // C44: built with the Settings switch (on unless switched off).
    expect(src).toMatch(/new AgentLoopGuard\(\{ enabled: useSettingsStore\.getState\(\)\.settings\.agentLoopGuard !== false \}\)/)
    expect(src).toContain("from '../lib/agent-loop-guard'")
  })

  it('feeds every batch as (name, stringified args) pairs', () => {
    expect(src).toContain('loopGuard.recordBatch(')
    expect(src).toContain('name: tc.function.name, args: JSON.stringify(tc.function.arguments)')
  })

  it('checks the narration channel too (repeated "Let me check…" lines)', () => {
    expect(src).toContain('loopGuard.recordNarration(turnContent)')
  })

  it('halts with a user-visible message and breaks the loop', () => {
    expect(src).toMatch(/halted: \$\{batchVerdict\.reason\}/)
    expect(src).toMatch(/stronger model/i)
  })

  it('injects the steer message into the model history, AFTER the calls it refers to', () => {
    expect(src).toMatch(/batchVerdict\.action === 'steer'/)
    expect(src).toContain("messages.push({ role: 'user', content: pendingSteer })")
    // Audit F2: pushed at detection time the steer landed chronologically
    // BEFORE the assistant tool_calls message it complains about, so the
    // history read "do not repeat this" and then showed the model doing it.
    const idxHold = src.indexOf('pendingSteer = batchVerdict.message')
    const idxPush = src.indexOf("messages.push({ role: 'user', content: pendingSteer })")
    const idxHistory = src.indexOf("messages.push({ role: 'assistant', content: turnContent || '', tool_calls: toolCalls, reasoning: replayableReasoning(turnReasoning) })")
    expect(idxHold).toBeGreaterThan(0)
    expect(idxHistory).toBeGreaterThan(idxHold)
    expect(idxPush).toBeGreaterThan(idxHistory)
  })

  it('checks the guard AFTER tool calls are collected but BEFORE executing', () => {
    // The detector sits between "toolCalls.length === 0 break" and the
    // batch-building for-loop — so it catches the repeat before we burn
    // an execution slot and another HTTP round-trip.
    const idxCheck = src.indexOf('loopGuard.recordBatch(')
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
