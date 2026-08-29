/**
 * E4 (Discord bug-reports 2026-08-09, helpslowlydying): flipping the Cloud
 * switch to Local with no local model installed left the lu-cloud model
 * silently active, and every chat kept billing cloud credits. The send path
 * now refuses any model from the wrong mode via modelOutOfMode, and the
 * AppShell reselect clears the selection when the new mode has no fallback.
 *
 * Run: npx vitest run src/lib/__tests__/modeGate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { modelOutOfMode } from '../modeGate'
import { pickForMode } from '../active-model-mode'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('modelOutOfMode: the money gate predicate', () => {
  it('blocks a lu-cloud model while the switch says Local (the reported bug)', () => {
    expect(modelOutOfMode('lu-cloud::moonshotai/Kimi-K3', 'local')).toBe(true)
  })

  it('NEGATIVE CONTROL: the same cloud model is fine in Cloud mode', () => {
    expect(modelOutOfMode('lu-cloud::moonshotai/Kimi-K3', 'cloud')).toBe(false)
  })

  it('blocks local models in Cloud mode (symmetric guard)', () => {
    expect(modelOutOfMode('qwen3:4b', 'cloud')).toBe(true) // Ollama, unprefixed
    expect(modelOutOfMode('openai::gemma-3-4b', 'cloud')).toBe(true) // built-in / LM Studio
  })

  it('NEGATIVE CONTROL: local models pass in Local mode', () => {
    expect(modelOutOfMode('qwen3:4b', 'local')).toBe(false)
    expect(modelOutOfMode('openai::gemma-3-4b', 'local')).toBe(false)
  })

  it('an empty selection is never out of mode (nothing to block)', () => {
    expect(modelOutOfMode(null, 'local')).toBe(false)
    expect(modelOutOfMode(undefined, 'cloud')).toBe(false)
    expect(modelOutOfMode('', 'local')).toBe(false)
  })
})

describe('wiring: the gate sits at the choke points', () => {
  it('sendMessage clears the selection and returns BEFORE any routing', () => {
    const src = read('../../hooks/useChat.ts')
    const guard = src.indexOf('modelOutOfMode(activeModel, settings.appMode)')
    const agentDelegation = src.indexOf('Agent mode delegation')
    expect(guard).toBeGreaterThan(-1)
    expect(agentDelegation).toBeGreaterThan(-1)
    // The guard must run before the agent/group/chat-tools routing, or a
    // wrong-mode model still reaches a provider through those paths.
    expect(guard).toBeLessThan(agentDelegation)
    expect(src.slice(guard, guard + 300)).toContain('setActiveModel(null)')
  })

  it('the AppShell reselect clears the selection when the new mode has no model', () => {
    // The rule moved into lib/active-model-mode.ts on 2026-08-29 so it could
    // be tested against an empty model list, which is what used to eat the
    // user's pick across a restart (Befund 3, abnahme counter-check). The
    // clearing behaviour is unchanged and is asserted here on the rule
    // itself, not on the shape of the call site.
    const src = read('../../components/layout/AppShell.tsx')
    expect(src).toContain('if (pick.change) setActiveModel(pick.next)')
    const cloudOnly = [{ name: 'lu-cloud::glm-5.3', type: 'text', provider: 'lu-cloud' }]
    expect(pickForMode('lu-cloud::glm-5.3', cloudOnly, 'local')).toEqual({ change: true, next: null })
  })
})
