/**
 * Smoke tests for the Codex AUTONOMY CONTRACT system prompt.
 *
 * The prompt is the most critical piece of the Codex agent — it controls
 * whether the model completes multi-step tasks autonomously or stops prematurely.
 *
 * These tests read the actual source file to verify the prompt content hasn't
 * drifted from the required contract terms.
 *
 * We also verify parity between desktop (useCodex.ts) and mobile (remote.rs)
 * CODEX_PROMPT variants.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

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

  it('defines the model as Codex', () => {
    expect(src).toContain('You are Codex')
  })
})

describe('Mobile CODEX_PROMPT (remote.rs) parity', () => {
  const mobileRs = readSource('../../../src-tauri/src/commands/remote.rs')

  it('mobile contains AUTONOMY CONTRACT', () => {
    expect(mobileRs).toContain('AUTONOMY CONTRACT')
  })

  it('mobile instructs completing all steps', () => {
    expect(mobileRs).toContain('COMPLETE multi-step tasks')
  })

  it('mobile defines the model as Codex', () => {
    expect(mobileRs).toContain('You are Codex')
  })

  it('mobile has CODEX_TOOLS constant', () => {
    expect(mobileRs).toContain('CODEX_TOOLS')
    // Must include file_read, file_write, shell_execute
    expect(mobileRs).toContain("'file_read'")
    expect(mobileRs).toContain("'file_write'")
    expect(mobileRs).toContain("'shell_execute'")
  })

  it('mobile has AGENT_ALL_TOOLS constant', () => {
    expect(mobileRs).toContain('AGENT_ALL_TOOLS')
  })
})

describe('Desktop ↔ Mobile prompt parity check', () => {
  const desktop = readSource('../useCodex.ts')
  const mobile = readSource('../../../src-tauri/src/commands/remote.rs')

  it('both have AUTONOMY CONTRACT', () => {
    expect(desktop).toContain('AUTONOMY CONTRACT')
    expect(mobile).toContain('AUTONOMY CONTRACT')
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
