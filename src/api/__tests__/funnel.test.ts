/**
 * The Cloud switch counter (David, 2026-09-06). Pins the four-name mapping,
 * that exactly one bridge call goes out per press with nothing but the
 * event, and that a dead bridge never reaches the switch.
 *
 * Run: npx vitest run src/api/__tests__/funnel.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
}))
const cloudFetch = vi.fn()
vi.mock('../cloud/client', () => ({
  cloudFetch: (...a: unknown[]) => cloudFetch(...a),
}))

import { funnelEventFor, reportCloudSwitch } from '../funnel'

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockResolvedValue(undefined)
  cloudFetch.mockReset()
  cloudFetch.mockResolvedValue(new Response(null, { status: 204 }))
})

describe('the Cloud switch counter', () => {
  it('maps the four presses to the four event names and nothing else', () => {
    expect(funnelEventFor('open-gate')).toBe('cloud_switch_gate')
    expect(funnelEventFor('arm')).toBe('cloud_switch_arm')
    expect(funnelEventFor('enter-cloud')).toBe('cloud_switch_enter')
    expect(funnelEventFor('leave-cloud')).toBe('cloud_switch_leave')
  })

  it('sends one bridge call per press carrying only the event name', () => {
    reportCloudSwitch('enter-cloud')
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(backendCall).toHaveBeenCalledWith('funnel_ping', { event: 'cloud_switch_enter' })
  })

  it('reports the same press once more per account, with the bearer path', () => {
    reportCloudSwitch('open-gate')
    expect(cloudFetch).toHaveBeenCalledTimes(1)
    const [path, init] = cloudFetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/funnel/switch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ event: 'cloud_switch_gate' })
  })

  it('stays anonymous when there is no session and never throws on a dead network', async () => {
    cloudFetch.mockImplementation(() => { throw new Error('no session') })
    expect(() => reportCloudSwitch('arm')).not.toThrow()
    cloudFetch.mockRejectedValue(new Error('offline'))
    expect(() => reportCloudSwitch('enter-cloud')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(backendCall).toHaveBeenCalledTimes(2)
  })

  it('never lets a failing bridge reach the switch', async () => {
    backendCall.mockRejectedValue(new Error('offline'))
    expect(() => reportCloudSwitch('arm')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    backendCall.mockImplementation(() => { throw new Error('no tauri') })
    expect(() => reportCloudSwitch('leave-cloud')).not.toThrow()
  })
})
