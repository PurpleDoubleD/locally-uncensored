/**
 * GH #214 (KensonPlayz): Magnitude (magnitudedev/magnitude) as a backend.
 * Its docs (cli/src/agent-docs/topics/remote-access.md, read 2026-11-14):
 * the OpenAI compatible API is on port 10100 under /inference/v1, on
 * 127.0.0.1 only unless Network access is on, and needs no key locally. So it
 * is a local preset like LM Studio, found by the same startup probe.
 *
 * Run: npx vitest run src/api/__tests__/magnitude-is-a-local-preset-214.test.ts
 */
import { describe, it, expect } from 'vitest'
import { PROVIDER_PRESETS } from '../providers/types'
import { PROBE_TARGETS } from '../../lib/backend-detector'

describe('Magnitude', () => {
  it('is a local OpenAI compatible preset on its documented address', () => {
    expect(PROVIDER_PRESETS.find((p) => p.id === 'magnitude')).toEqual({
      id: 'magnitude', name: 'Magnitude', providerId: 'openai', baseUrl: 'http://127.0.0.1:10100/inference/v1', isLocal: true,
    })
  })

  it('is looked for at startup, at its models list', () => {
    const t = PROBE_TARGETS.find((p) => p.id === 'magnitude')!
    expect(t).toBeDefined()
    expect(`${t.baseUrl}/models`).toBe('http://127.0.0.1:10100/inference/v1/models')
  })

  it('NEGATIVE CONTROL: it asks for no key and no other preset moved', () => {
    expect(PROVIDER_PRESETS.find((p) => p.id === 'magnitude')).not.toHaveProperty('placeholder')
    expect(PROVIDER_PRESETS.find((p) => p.id === 'lmstudio')!.baseUrl).toBe('http://localhost:1234/v1')
  })
})
