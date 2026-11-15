/**
 * One anonymous counter for the Cloud switch (2026-09-06): how many
 * presses open the gate, arm the switch, enter Cloud or go back to Local.
 *
 * The frontend hands the Rust side nothing but the event name; platform and
 * app version are read there, and the four names are the whole allowlist on
 * both sides (commands/funnel.rs and the server). Fire and
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
  | GateFunnelEvent

/** The clicks in the gate pop-up (3.0.7): a model, then one of the two ways
 *  in. The name is the whole message here too; which model goes with the
 *  checkout, never with the counter. */
export type GateFunnelEvent =
  | 'cloud_gate_model_click'
  | 'cloud_gate_pick_sub'
  | 'cloud_gate_pick_credits'
  | OfferFunnelEvent

/** The rest of the ways into LU Cloud (funnel 3.1.0, Nr. 3). Until then only
 *  the model dropdowns of the gate were counted; the main button, the sign in
 *  and the Create sheet were not, and 97 percent of the gate stayed blind.
 *  Each name is one click on one button, nothing about who or which model:
 *    cloud_gate_main_sub     gate, signed out: Subscribe
 *    cloud_gate_main_pack    gate, signed out: Credit pack, no subscription
 *    cloud_gate_signin       gate, signed out: Already bought? Sign in
 *    cloud_gate_plan_click   gate: a plan button or See all plans
 *    cloud_teaser_sub        Create sheet: Subscribe
 *    cloud_teaser_pack       Create sheet: Credit pack
 *    cloud_teaser_hide       Create sheet: Don't show Cloud features
 *    cloud_offer_click       a model tile or Create: Try LU Cloud
 *    cloud_onboarding_hint   onboarding, small card: Run it in LU Cloud
 *  Opening the gate is not a name of its own: the switch already counts it
 *  (cloud_switch_gate), and a second count of the same visit would make the
 *  steps after it look rarer than they are. */
export type OfferFunnelEvent =
  | 'cloud_gate_main_sub'
  | 'cloud_gate_main_pack'
  | 'cloud_gate_signin'
  | 'cloud_gate_plan_click'
  | 'cloud_teaser_sub'
  | 'cloud_teaser_pack'
  | 'cloud_teaser_hide'
  | 'cloud_offer_click'
  | 'cloud_onboarding_hint'

export function funnelEventFor(action: CloudSwitchAction): FunnelEvent {
  switch (action) {
    case 'open-gate': return 'cloud_switch_gate'
    case 'arm': return 'cloud_switch_arm'
    case 'enter-cloud': return 'cloud_switch_enter'
    case 'leave-cloud': return 'cloud_switch_leave'
  }
}

export function reportCloudSwitch(action: CloudSwitchAction): void {
  const event = reportCloudSwitchAnonymous(action)
  reportCloudSwitchForAccount(event)
}

/** A click in the gate pop-up, counted like a press of the switch. */
export function reportCloudGate(event: GateFunnelEvent): void {
  reportFunnelAnonymous(event)
  reportCloudSwitchForAccount(event)
}

/**
 * The anonymous half alone: event name, platform, app version, no session.
 * The phone counts only through this one (api/cloud/switch-counter.ts), so
 * its Privacy page can say "No account, no content" and be right
 * (durchsicht-mobile M2). Returns the event it counted.
 */
export function reportCloudSwitchAnonymous(action: CloudSwitchAction): FunnelEvent {
  // Written out here, not through reportFunnelAnonymous: the Privacy check of
  // the phone (ios-privacy-manifest.test.ts) reads this body for what it sends.
  const event = funnelEventFor(action)
  try {
    void backendCall('funnel_ping', { event }).catch(() => {})
  } catch {
    /* no bridge (web build): the press is simply not counted */
  }
  return event
}

function reportFunnelAnonymous(event: FunnelEvent): FunnelEvent {
  try {
    void backendCall('funnel_ping', { event }).catch(() => {})
  } catch {
    /* no bridge (web build): the press is simply not counted */
  }
  return event
}

/**
 * The same press once more, per account (2026-09-07: split the
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
