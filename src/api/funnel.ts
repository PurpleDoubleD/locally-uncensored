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
  try {
    void backendCall('funnel_ping', { event: funnelEventFor(action) }).catch(() => {})
  } catch {
    /* no bridge (web build): the press is simply not counted */
  }
}
