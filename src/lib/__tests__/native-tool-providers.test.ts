/**
 * Cloud providers must never be routed through the Ollama name heuristics.
 *
 * Live repro 2026-07-27 (Chat tab, Cloud on, Kimi K2.6): `lu-cloud` was missing
 * from the native-tool provider list, so getToolCallingStrategy fell through to
 * the Ollama family match. Families that happen to appear in AGENT_COMPATIBLE
 * (qwen3-coder, hermes, …) still resolved to 'native' — which is why the Code
 * tab worked — but everything else got 'hermes_xml', whose branch posts to the
 * LOCAL Ollama endpoint via chatNonStreaming(). The cloud model isn't installed
 * locally, so the whole agent run died with "Chat API error: 404".
 */
import { describe, it, expect } from 'vitest'
import {
  isNativeToolProvider,
  getToolCallingStrategy,
  isAgentCompatible,
  isThinkingCompatible,
  isVisionCompatible,
} from '../model-compatibility'

// Real catalogue ids from /api/inference/v1/models, prefixed the way the model
// store keeps them (see prefixModelName).
//
// Two of the four were NOT real and had drifted unnoticed: this file claimed
// Sao10K/L3.3-70B-Euryale-v2.3 and MiniMaxAI/MiniMax-M2 while the catalogue has
// carried v2.2 and M2.7 for a while (apps/web/lib/chat/tier-models.ts:150 and
// :287, checked 2026-09-02). Nothing went red, because the cloud path answers
// 'native' for any id at all, so the test kept passing while proving none of
// what its own comment promised. Corrected here; there is no automatic guard,
// the catalogue lives in the web repo, so this list is checked by hand whenever
// the catalogue moves.
const CLOUD = {
  kimi: 'lu-cloud::moonshotai/Kimi-K2.6',
  coder: 'lu-cloud::Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
  euryale: 'lu-cloud::Sao10K/L3.1-70B-Euryale-v2.2',
  minimax: 'lu-cloud::MiniMaxAI/MiniMax-M2.7',
}

describe('isNativeToolProvider', () => {
  it('covers every provider that speaks OpenAI-style tool calling', () => {
    expect(isNativeToolProvider('lu-cloud')).toBe(true)
    expect(isNativeToolProvider('openai')).toBe(true)
    expect(isNativeToolProvider('anthropic')).toBe(true)
  })

  it('leaves Ollama on the local name heuristics', () => {
    expect(isNativeToolProvider('ollama')).toBe(false)
  })
})

describe('getToolCallingStrategy — LU Cloud', () => {
  it('is native for EVERY cloud model, including families the Ollama list never heard of', () => {
    for (const [name, id] of Object.entries(CLOUD)) {
      expect(getToolCallingStrategy(id), `${name} must not fall back to hermes_xml`).toBe('native')
    }
  })

  it('the two ids that had drifted stay corrected', () => {
    // A pin, not a proof: nothing local can tell a real catalogue id from a
    // plausible one, because the catalogue lives in the web repo. What this
    // does do is make the two ids load-bearing, so drifting them back is a red
    // test instead of a silent no-op the way it was for weeks.
    expect(CLOUD.euryale).toBe('lu-cloud::Sao10K/L3.1-70B-Euryale-v2.2')
    expect(CLOUD.minimax).toBe('lu-cloud::MiniMaxAI/MiniMax-M2.7')
  })

  it('still routes Ollama models by family (regression guard for the local path)', () => {
    expect(getToolCallingStrategy('qwen2.5-coder:7b')).toBe('native')
    expect(getToolCallingStrategy('smollm2:360m')).toBe('hermes_xml')
  })
})

describe('capability checks stay lenient for LU Cloud', () => {
  it('treats cloud models as agent/think/vision capable — the server catalogue is the authority', () => {
    expect(isAgentCompatible(CLOUD.kimi)).toBe(true)
    expect(isThinkingCompatible(CLOUD.kimi)).toBe(true)
    expect(isVisionCompatible(CLOUD.kimi)).toBe(true)
  })

  it('does not leak that leniency to Ollama tags', () => {
    expect(isAgentCompatible('smollm2:360m')).toBe(false)
    expect(isThinkingCompatible('smollm2:360m')).toBe(false)
    expect(isVisionCompatible('smollm2:360m')).toBe(false)
  })
})
