/**
 * Every link from the desktop app to lu-labs.ai, with where it came from
 * (funnel 13.11.2026, Nr. 3).
 *
 * Until 3.1.0 no link out of the app said where it was clicked: a purchase
 * that started on the gate's main button landed without any source, and the
 * report could not tell the app from a Google visitor. Each link now carries
 * `utm_source=desktop` and `utm_medium=<the place>`, so the web side can file
 * the visit and the account under the place in the app (account_sources). The
 * short `src` word the checkout already reads stays where it was.
 *
 * Nothing about the user goes into a link: the source, the place in the app
 * and, for the checkout, the order and the gate model. No identifier.
 *
 * Pure: no store, no network.
 */
import { CLOUD_BASE } from '../api/cloud/config'

/** The places in the app a link to lu-labs.ai can start from. */
export type CloudLinkMedium =
  | 'gate'
  | 'gate-models'
  | 'gate-plans'
  | 'create-sheet'
  | 'onboarding'
  | 'account'
  | 'settings'
  | 'credits-meter'
  | 'credits-empty'

/** Where the gate was opened from. Goes with a gate link as utm_content, so
 *  "the gate brought it" can be split by the way into the gate. */
export type CloudGateOpener =
  | 'switch'
  | 'model-picker'
  | 'cloud-offer'
  | 'release-notes'
  | 'checkout-return'

export const UTM_SOURCE = 'desktop'

/** The scheme the desktop app answers (src-tauri/src/hf_link.rs). Sent with a
 *  checkout so the page after the payment can offer the way back into the
 *  app. A page that does not know the parameter ignores it. */
export const APP_RETURN_SCHEME = 'locallyuncensored'

/** `path` on lu-labs.ai with the source of the click. A hash stays at the end. */
export function cloudLink(path: string, medium: CloudLinkMedium, opener?: CloudGateOpener, base: string = CLOUD_BASE): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, 'https://lu.invalid')
  url.searchParams.set('utm_source', UTM_SOURCE)
  url.searchParams.set('utm_medium', medium)
  if (opener) url.searchParams.set('utm_content', opener)
  return `${base}${url.pathname}${url.search}${url.hash}`
}

/** The two ways in, side by side everywhere the app sells (Nr. 4). */
export type CheckoutOrder = 'sub' | 'pack'

/** The first plan, monthly, and the smallest pack: what the two buttons buy. */
export const CHECKOUT_PLAN = { tier: 'hosted', interval: 'month' } as const
export const CHECKOUT_PACK = 'pack-15'

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,80}$/
const SOURCE = /^[a-z0-9_-]{1,32}$/

export interface CheckoutLinkOptions {
  order: CheckoutOrder
  /** The short source word the checkout counts (`app-gate`, `gpu8`). */
  src: string
  medium: CloudLinkMedium
  opener?: CloudGateOpener
  /** The gate model the app lands on after the purchase. */
  model?: string
  category?: 'chat' | 'code' | 'create'
  base?: string
}

/**
 * The checkout start on lu-labs.ai, never the payment page itself: the page there shows
 * the order and the alternative before anybody pays, and signs in first when
 * nobody is. `return=app` asks every way back from the payment to offer the
 * app, `scheme` says which link opens it.
 */
export function checkoutStartUrl(o: CheckoutLinkOptions): string {
  const q = new URLSearchParams(o.order === 'sub'
    ? { plan: CHECKOUT_PLAN.tier, interval: CHECKOUT_PLAN.interval }
    : { pack: CHECKOUT_PACK })
  if (SOURCE.test(o.src)) q.set('src', o.src)
  if (o.model && MODEL_ID.test(o.model)) q.set('model', o.model)
  if (o.category) q.set('category', o.category)
  q.set('return', 'app')
  q.set('scheme', APP_RETURN_SCHEME)
  return cloudLink(`/checkout/start?${q.toString()}`, o.medium, o.opener, o.base)
}
