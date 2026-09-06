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

import { funnelEventFor, reportCloudSwitch } from '../funnel'

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockResolvedValue(undefined)
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

  it('never lets a failing bridge reach the switch', async () => {
    backendCall.mockRejectedValue(new Error('offline'))
    expect(() => reportCloudSwitch('arm')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    backendCall.mockImplementation(() => { throw new Error('no tauri') })
    expect(() => reportCloudSwitch('leave-cloud')).not.toThrow()
  })
})
