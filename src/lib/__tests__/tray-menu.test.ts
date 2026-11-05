import { describe, expect, it } from 'vitest'
import { cloudTrayStatus, localTrayStatus, planName } from '../tray-menu'

const signedIn = {
  signedIn: true,
  probing: false,
  tier: 'hosted-pro',
  licenseActive: true,
  pastDue: false,
  credits: 1240,
}

describe('tray menu lines (T2)', () => {
  it('cloud: signed in, plan, credits, then Plan & Credits — no e-mail', () => {
    expect(cloudTrayStatus(signedIn)).toEqual({
      lines: [
        { text: 'LU Cloud · Signed in' },
        { text: 'Hosted Pro plan · active', dot: 'green' },
        { text: '1,240 credits left' },
      ],
      action: 'plan',
    })
  })

  it('cloud: a failed payment is amber, no plan is grey', () => {
    expect(cloudTrayStatus({ ...signedIn, pastDue: true }).lines[1]).toEqual({ text: 'Hosted Pro plan · payment failed', dot: 'amber' })
    expect(cloudTrayStatus({ ...signedIn, licenseActive: false }).lines[1]).toEqual({ text: 'No active plan', dot: 'grey' })
  })

  it('cloud: signed out and still asking keep the three lines', () => {
    expect(cloudTrayStatus({ ...signedIn, signedIn: false }).lines.map((l) => l.text)).toEqual([
      'LU Cloud · Signed out',
      'No plan',
      'Sign in under Plan & Credits',
    ])
    expect(cloudTrayStatus({ ...signedIn, probing: true }).lines.map((l) => l.text)).toEqual(['LU Cloud · Connecting…', 'Plan …', 'Credits …'])
  })

  it('cloud: unknown credits say so, never a 0', () => {
    expect(cloudTrayStatus({ ...signedIn, credits: null }).lines[2].text).toBe('Credits …')
    expect(cloudTrayStatus({ ...signedIn, credits: -3.5 }).lines[2].text).toBe('0 credits left')
  })

  it('every state has three lines, so the open menu is never rebuilt (and closed)', () => {
    const states = [
      cloudTrayStatus(signedIn),
      cloudTrayStatus({ ...signedIn, signedIn: false }),
      cloudTrayStatus({ ...signedIn, probing: true }),
      cloudTrayStatus({ ...signedIn, pastDue: true, credits: null }),
      localTrayStatus({ engine: null, model: null, state: 'unknown', memory: null }),
      localTrayStatus({ engine: 'LU Engine', model: 'm', state: 'ready', memory: { label: 'Memory', usedGb: 1, totalGb: 8 } }),
    ]
    for (const s of states) expect(s.lines).toHaveLength(3)
  })

  it('a tier without a known name still reads like one', () => {
    expect(planName('hosted-max')).toBe('Hosted Max')
    expect(planName('self-host')).toBe('Self Host')
  })

  it('local: engine, model with its state, memory, then Models', () => {
    expect(
      localTrayStatus({ engine: 'LU Engine', model: 'Qwen3 8B', state: 'ready', memory: { label: 'Memory', usedGb: 9.24, totalGb: 24 } }),
    ).toEqual({
      lines: [
        { text: 'Local · LU Engine' },
        { text: 'Qwen3 8B · ready', dot: 'green' },
        { text: 'Memory 9.2 of 24 GB' },
      ],
      action: 'models',
    })
  })

  it('local: the same three-line build as the cloud menu', () => {
    const local = localTrayStatus({ engine: 'Ollama', model: 'llama3', state: 'idle', memory: { label: 'GPU memory', usedGb: 1, totalGb: 12 } })
    expect(local.lines).toHaveLength(cloudTrayStatus(signedIn).lines.length)
    expect(local.lines[1]).toEqual({ text: 'llama3 · loads on first chat', dot: 'grey' })
  })

  it('local: no model, a stopped Ollama, a server LU does not ask', () => {
    expect(localTrayStatus({ engine: null, model: null, state: 'unknown', memory: null }).lines).toEqual([
      { text: 'Local' },
      { text: 'No model selected', dot: 'grey' },
      { text: 'Memory …' },
    ])
    expect(localTrayStatus({ engine: 'Ollama', model: 'm', state: 'engine-off', memory: null }).lines[1]).toEqual({ text: 'm · not running', dot: 'amber' })
    expect(localTrayStatus({ engine: 'LM Studio', model: 'm', state: 'unknown', memory: null }).lines[1]).toEqual({ text: 'm' })
  })
})
