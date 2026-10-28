import { describe, expect, it } from 'vitest'
import {
  backendNote,
  clampStrength,
  effectiveStrengths,
  entriesFor,
  hasPersonaProfile,
  jobProgressText,
  jobShare,
  personaProfileKey,
  sameEntries,
  shortDuration,
  strengthWarning,
} from '../neuron'
import type { NeuronJob } from '../../api/neuron'
import type { Profiles } from '../neuron'

const job = (over: Partial<NeuronJob>): NeuronJob => ({
  status: 'running', kind: 'build', title: '', modelPath: '/m.gguf', phaseLabel: '', step: 0, total: 0,
  bytesDone: 0, bytesTotal: 0, rateBps: 0, etaSecs: null, elapsedSecs: 0, resultId: null, error: null, logs: [],
  ...over,
})

describe('neuron profiles', () => {
  const profiles: Profiles = {
    'qwen-1': { creative: 0.5 },
    [personaProfileKey('qwen-1', 'pirate')]: { casual: 1 },
  }

  it('uses the persona profile when there is one, else the model profile', () => {
    expect(effectiveStrengths(profiles, 'qwen-1', 'pirate')).toEqual({ casual: 1 })
    expect(effectiveStrengths(profiles, 'qwen-1', 'unrestricted')).toEqual({ creative: 0.5 })
    expect(effectiveStrengths(profiles, 'qwen-1', null)).toEqual({ creative: 0.5 })
    expect(effectiveStrengths(profiles, 'other', 'pirate')).toEqual({})
    expect(hasPersonaProfile(profiles, 'qwen-1', 'pirate')).toBe(true)
    expect(hasPersonaProfile(profiles, 'qwen-1', 'x')).toBe(false)
  })

  it('sends only sliders that are on and computed, sorted', () => {
    const entries = entriesFor({ b: 0.3, a: -0.5, off: 0, missing: 1, tiny: 0.01 }, new Set(['a', 'b', 'off', 'tiny']))
    expect(entries).toEqual([{ id: 'a', strength: -0.5 }, { id: 'b', strength: 0.3 }])
  })

  it('clamps and snaps the middle to exactly zero', () => {
    expect(clampStrength(3)).toBe(1)
    expect(clampStrength(-3)).toBe(-1)
    expect(clampStrength(0.011)).toBe(0)
    expect(clampStrength(Number.NaN)).toBe(0)
    expect(clampStrength(0.333)).toBe(0.33)
  })

  it('compares entry lists by value', () => {
    expect(sameEntries([{ id: 'a', strength: 0.5 }], [{ id: 'a', strength: 0.5 }])).toBe(true)
    expect(sameEntries([{ id: 'a', strength: 0.5 }], [{ id: 'a', strength: 0.6 }])).toBe(false)
    expect(sameEntries([], [])).toBe(true)
  })
})

describe('neuron warnings', () => {
  it('warns at high strength and louder with several strong sliders', () => {
    expect(strengthWarning([{ id: 'a', strength: 0.5 }])).toBeNull()
    expect(strengthWarning([{ id: 'a', strength: 0.9 }])).toBe('strong')
    expect(strengthWarning([{ id: 'a', strength: 0.6 }, { id: 'b', strength: -0.6 }])).toBe('strong')
    expect(strengthWarning([{ id: 'a', strength: 1 }, { id: 'b', strength: 0.8 }])).toBe('overload')
  })

  it('names the backend that cannot be steered', () => {
    expect(backendNote('lu-engine')).toBeNull()
    expect(backendNote('ollama')).toMatch(/Ollama takes no control vectors/)
    expect(backendNote('cloud')).toMatch(/Cloud/)
  })
})

describe('neuron progress', () => {
  it('reads a download like the other downloads: MB, %, speed, time left', () => {
    const j = job({ kind: 'download', bytesDone: 12e6, bytesTotal: 42e6, rateBps: 3.1e6, etaSecs: 9 })
    expect(jobProgressText(j)).toBe('12 MB of 42 MB · 29% · 3.1 MB/s · 9 s left')
  })

  it('reads a computation as examples and steps', () => {
    expect(jobProgressText(job({ phaseLabel: 'Reading the examples through the model', step: 12, total: 40, etaSecs: 20 })))
      .toBe('Example 12 of 40 · 30% · 20 s left')
    expect(jobProgressText(job({ phaseLabel: 'Finding the strongest setting', step: 3, total: 12, etaSecs: 70 })))
      .toBe('Step 3 of 12 · 25% · 1 min left')
    expect(jobProgressText(job({ elapsedSecs: 5 }))).toBe('running for 5 s')
  })

  it('knows its share only when something is counted', () => {
    expect(jobShare(job({}))).toBeNull()
    expect(jobShare(job({ step: 5, total: 10 }))).toBe(0.5)
    expect(jobShare(job({ bytesDone: 50, bytesTotal: 100, step: 1, total: 10 }))).toBe(0.5)
  })

  it('writes durations short', () => {
    expect(shortDuration(42)).toBe('42 s')
    expect(shortDuration(150)).toBe('3 min')
    expect(shortDuration(3900)).toBe('1 h 5 min')
  })
})
