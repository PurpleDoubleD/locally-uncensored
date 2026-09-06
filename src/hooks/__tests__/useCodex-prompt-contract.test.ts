/**
 * Smoke tests for the Codex AUTONOMY CONTRACT system prompt.
 *
 * The prompt is the most critical piece of the Codex agent — it controls
 * whether the model completes multi-step tasks autonomously or stops prematurely.
 *
 * These tests read the actual source file to verify the prompt content hasn't
 * drifted from the required contract terms.
 *
 * We also verify parity between desktop (useCodex.ts) and mobile
 * (mobile-client/) CODEX_PROMPT variants.
 *
 * ── 01.09.2026 (T-75) ──
 *
 * The mobile half used to read src-tauri/src/commands/remote.rs as one string
 * and ask `toContain('AUTONOMY CONTRACT')` of the whole 7 483-line file. That
 * was green if the phrase sat anywhere: in the client, in a Rust comment, in a
 * Rust test's expectation. The client is real source now, so the prompt and
 * the tool lists are imported and the assertions are about the prompt itself.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { CODEX_PROMPT } from '../../../mobile-client/personas.js'
import { AGENT_ALL_TOOLS, CODEX_TOOLS } from '../../../mobile-client/agent-core.js'

function readSource(relativePath: string): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  return readFileSync(resolve(__dirname, relativePath), 'utf8')
}

describe('Desktop CODEX_SYSTEM_PROMPT (useCodex.ts)', () => {
  const src = readSource('../useCodex.ts')

  it('contains AUTONOMY CONTRACT header', () => {
    expect(src).toContain('AUTONOMY CONTRACT')
  })

  it('instructs model to complete ALL steps without stopping', () => {
    expect(src).toContain('COMPLETE multi-step tasks')
    expect(src).toContain('execute ALL N steps')
  })

  it('forbids premature stopping with narrative text', () => {
    expect(src).toContain('premature stop')
  })

  it('defines the 5-step workflow', () => {
    expect(src).toContain('Understand the task')
    expect(src).toContain('Explore the codebase')
    expect(src).toContain('Implement ALL required changes')
    expect(src).toContain('Verify')
    expect(src).toContain('short summary')
  })

  it('requires reading before modifying', () => {
    expect(src).toContain('Always read a file before modifying it')
  })

  it('instructs chaining tool calls', () => {
    expect(src).toContain('Chain tool calls')
  })

  it('defines the model as the Coding Agent', () => {
    expect(src).toContain('You are the Coding Agent')
  })
})

describe('Mobile CODEX_PROMPT (mobile-client/personas.js) parity', () => {
  it('mobile contains the hard rules the contract is made of', () => {
    // The old assertion was `toContain('AUTONOMY CONTRACT')` against the whole
    // Rust file. The mobile prompt does not use that heading — it says
    // "HARD RULES" — and it passed anyway, on the desktop prompt's heading
    // quoted in a neighbouring Rust test.
    expect(CODEX_PROMPT).toContain('=== HARD RULES ===')
    expect(CODEX_PROMPT).toContain('=== WORKFLOW ===')
  })

  it('mobile instructs completing all steps', () => {
    // Round 7: stronger wording — same intent, different verbatim string.
    expect(CODEX_PROMPT).toContain('execute ALL N steps in one session')
  })

  it('mobile defines the model as the Coding Agent', () => {
    expect(CODEX_PROMPT.startsWith('You are the Coding Agent')).toBe(true)
  })

  it('CODEX_TOOLS carries the three the prompt promises', () => {
    for (const t of ['file_read', 'file_write', 'shell_execute']) {
      expect(CODEX_TOOLS).toContain(t)
    }
  })

  it('AGENT_ALL_TOOLS is a superset of CODEX_TOOLS', () => {
    for (const t of CODEX_TOOLS) expect(AGENT_ALL_TOOLS).toContain(t)
    expect(AGENT_ALL_TOOLS.length).toBeGreaterThan(CODEX_TOOLS.length)
  })
})

describe('Desktop ↔ Mobile prompt parity check', () => {
  const desktop = readSource('../useCodex.ts')
  const mobile = CODEX_PROMPT

  it('both open with a named block of hard rules', () => {
    // FINDING (01.09.2026): they do not share a heading. The desktop prompt
    // says "AUTONOMY CONTRACT", the mobile one says "HARD RULES". The old
    // test asserted the desktop heading against the whole Rust file and was
    // green on a copy of the desktop prompt quoted in a Rust test — so
    // "both have AUTONOMY CONTRACT" was never true of the phone.
    expect(desktop).toContain('AUTONOMY CONTRACT')
    expect(mobile).toContain('=== HARD RULES ===')
  })

  it('both instruct chaining tool calls', () => {
    expect(desktop).toContain('Chain tool calls')
    expect(mobile).toContain('Chain tool calls')
  })

  it('both forbid stopping with narrative text', () => {
    // Desktop says "premature stop", mobile says "That is a FAILURE"
    expect(desktop).toContain('FAILURE')
    expect(mobile).toContain('FAILURE')
  })

  it('both instruct executing ALL steps', () => {
    expect(desktop).toContain('ALL N steps')
    expect(mobile).toContain('ALL N steps')
  })
})
