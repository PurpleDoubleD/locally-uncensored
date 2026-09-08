/**
 * One anonymous counter for the Cloud switch (David, 2026-09-06): how many
 * presses open the gate, arm the switch, enter Cloud or go back to Local.
 *
 * The frontend hands the Rust side nothing but the event name; platform and
 * app version are read there, and the four names are the whole allowlist on
 * both sides (commands/funnel.rs, migration 0033_cloud_funnel). Fire and
 * forget: the switch never waits on the counter and never hears from it, so a
 * machine without a connection, a web build without Tauri, or a server that
 * is down all cost the press nothing.
 */
import { backendCall } from './backend'
import { cloudFetch } from './cloud/client'
import type { CloudSwitchAction } from '../lib/cloud-switch-guard'

export type FunnelEvent =
  | 'cloud_switch_gate'
  | 'cloud_switch_arm'
  | 'cloud_switch_enter'
  | 'cloud_switch_leave'

export function funnelEventFor(action: CloudSwitchAction): FunnelEvent {
  switch (action) {
    case 'open-gate': return 'cloud_switch_gate'
    case 'arm': return 'cloud_switch_arm'
    case 'enter-cloud': return 'cloud_switch_enter'
    case 'leave-cloud': return 'cloud_switch_leave'
  }
}

export function reportCloudSwitch(action: CloudSwitchAction): void {
  const event = funnelEventFor(action)
  try {
    void backendCall('funnel_ping', { event }).catch(() => {})
  } catch {
    /* no bridge (web build): the press is simply not counted */
  }
  reportCloudSwitchForAccount(event)
}

/**
 * The same press once more, per account (David, 2026-09-07: split the
 * presses into subscribers and the rest, and see how often one person
 * presses). Signed in only: cloudFetch has no session for a signed-out
 * session and throws, and that press stays anonymous by design. Fire and
 * forget like the anonymous counter; a dead network costs the press nothing.
 */
export function reportCloudSwitchForAccount(event: FunnelEvent): void {
  try {
    void cloudFetch('/api/funnel/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
      timeoutMs: 5_000,
    }).catch(() => {})
  } catch {
    /* nothing to count without a session */
  }
}
