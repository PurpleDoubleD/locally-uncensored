/**
 * Mobile ↔ Desktop parity smoke tests for Codex and Agent.
 *
 * The mobile web app lives as embedded JS in remote.rs. These tests verify
 * structural parity between desktop TypeScript and mobile JS implementations:
 *
 * - CODEX_TOOLS tool list matches desktop tool categories
 * - AGENT_ALL_TOOLS covers all registered tools
 * - runToolLoop exists with proper loop termination
 * - nativeToolChat uses correct Ollama API format
 * - Hidden message filtering in renderChat
 * - stripThinkTags exists for thinking content
 * - Fallback final answer exists
 * - Max iteration guard (no infinite loops)
 * - Permission defaults (all ON for mobile)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const REMOTE_RS = readFileSync(resolve(__dirname, '../../../src-tauri/src/commands/remote.rs'), 'utf8')

describe('Mobile CODEX_TOOLS parity', () => {
  it('includes file_read', () => {
    expect(REMOTE_RS).toContain("'file_read'")
  })

  it('includes file_write', () => {
    expect(REMOTE_RS).toContain("'file_write'")
  })

  it('includes file_list', () => {
    expect(REMOTE_RS).toContain("'file_list'")
  })

  it('includes file_search', () => {
    expect(REMOTE_RS).toContain("'file_search'")
  })

  it('includes shell_execute', () => {
    expect(REMOTE_RS).toContain("'shell_execute'")
  })

  it('includes code_execute', () => {
    expect(REMOTE_RS).toContain("'code_execute'")
  })

  it('includes system_info', () => {
    expect(REMOTE_RS).toContain("'system_info'")
  })

  it('includes web_search', () => {
    expect(REMOTE_RS).toContain("'web_search'")
  })

  it('includes web_fetch', () => {
    expect(REMOTE_RS).toContain("'web_fetch'")
  })
})

describe('Mobile runToolLoop', () => {
  it('function exists', () => {
    expect(REMOTE_RS).toContain('function runToolLoop')
  })

  it('has max iteration guard', () => {
    // Mobile should cap iterations to prevent infinite loops
    expect(REMOTE_RS).toMatch(/maxIter|MAX_ITER|iter\s*>=\s*\d+|iter\s*<\s*\d+/)
  })

  it('checks for empty tool_calls to terminate loop', () => {
    expect(REMOTE_RS).toMatch(/toolCalls.*length\s*===?\s*0|!res\.toolCalls/)
  })

  it('supports user abort', () => {
    expect(REMOTE_RS).toContain('agentAbort')
  })
})

describe('Mobile nativeToolChat', () => {
  it('function exists', () => {
    expect(REMOTE_RS).toContain('function nativeToolChat')
  })

  it('sends tools parameter to Ollama', () => {
    expect(REMOTE_RS).toContain('tools:')
  })

  it('uses /api/chat endpoint', () => {
    expect(REMOTE_RS).toContain('/api/chat')
  })
})

describe('Mobile hidden message handling', () => {
  it('renderChat skips hidden messages', () => {
    expect(REMOTE_RS).toContain('m.hidden')
  })

  it('hidden messages spliced into conversation for API context', () => {
    // Hidden messages must be in msgs[] for the LLM to see tool history
    expect(REMOTE_RS).toContain('hidden: true')
  })
})

describe('Mobile thinking support', () => {
  it('stripThinkTags function exists', () => {
    expect(REMOTE_RS).toContain('stripThinkTags')
  })

  it('handles Ollama native thinking field', () => {
    expect(REMOTE_RS).toContain('res.thinking')
  })
})

describe('Mobile fallback final answer', () => {
  it('builds summary when content is empty', () => {
    expect(REMOTE_RS).toContain('file(s) written')
  })

  it('finishToolLoop function exists', () => {
    expect(REMOTE_RS).toContain('finishToolLoop')
  })
})

describe('Mobile permissions', () => {
  it('all permissions default to ON', () => {
    // RemotePermissions::default() should have all true
    expect(REMOTE_RS).toMatch(/impl\s+Default\s+for\s+RemotePermissions/)
    // Check for `true` defaults (field names: filesystem, downloads, process_control)
    expect(REMOTE_RS).toMatch(/filesystem:\s*true/)
    expect(REMOTE_RS).toMatch(/downloads:\s*true/)
    expect(REMOTE_RS).toMatch(/process_control:\s*true/)
  })
})

describe('Mobile Codex vs Agent routing', () => {
  it('Codex mode uses CODEX_TOOLS', () => {
    expect(REMOTE_RS).toContain('isCodexChat ? CODEX_TOOLS')
  })

  it('Agent mode uses AGENT_ALL_TOOLS', () => {
    expect(REMOTE_RS).toContain('AGENT_ALL_TOOLS')
  })
})
