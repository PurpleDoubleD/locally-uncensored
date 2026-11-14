// Client-side signal for LU Cloud's `code: 'credits_exhausted'` (out of
// credits, top-up wallet empty). Any request layer that spots the code fires
// ONE window event; the globally mounted CreditsExhaustedModal turns it into
// the "Load up your credits" dialog instead of a dead-end chat error. An
// event (not a store) so the non-React provider layer can raise it without
// new dependencies.

import { CLOUD_BASE } from '../api/cloud/config'
import { cloudLink } from './cloud-links'

export const CREDITS_EXHAUSTED_EVENT = 'lu:credits-exhausted'

/** Which cap said no, drives the dialog title and copy. 'credits' = the
 *  shared pool, 'video_budget' = the monthly video sub-budget (top-ups
 *  bypass it), 'trainings' = no included run remains and the top-up wallet
 *  cannot cover the selected training. Matches the web app-
 *  exhausted.ts, so the same server code reads the same on both apps
 *  (R5-51). */
export type ExhaustedReason = 'credits' | 'video_budget' | 'trainings'

/**
 * Wohin der Knopf fuehrt: auf die Preisseite, nicht in einen Kauf.
 *
 * R5-51, Entscheid vom 12.09.2026. Der Knopf ging bis dahin auf die
 * Aufladeseite, also mitten in einen Kauf hinein, und traf damit fuer den
 * Kunden eine Entscheidung, die er noch gar nicht getroffen hatte: wer leer
 * ist, hat die Wahl zwischen einem Plan und einem Paket, und die Uebersicht
 * darueber steht auf der Preisseite. Gekauft wird weiter auf der Website und
 * nie in dieser App.
 *
 * Zusammengesetzt aus der bestehenden App-Adresse, damit eine Entwicklung
 * gegen einen lokalen Server nicht in die Live-Seite laeuft.
 */
export const PRICING_URL = `${CLOUD_BASE}/pricing`

/** The same page for the dialog's button, with where the click came from
 *  (lib/cloud-links). The sentence in the transcript keeps the plain address:
 *  it is read, not clicked, and a query string there is noise. */
export const PRICING_LINK = cloudLink('/pricing', 'credits-empty')

export function signalCreditsExhausted(reason: ExhaustedReason = 'credits'): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CREDITS_EXHAUSTED_EVENT, { detail: { reason } }))
  }
}

/**
 * What the transcript says. The dialog above opens on top of the answer, but a
 * dismissed dialog leaves nothing behind, and on a long agent run the last line
 * in the chat is the only thing the user still reads minutes later (Morgan,
 * 2026-08-10: an out-of-credits run read as "it is still cycling"). Every
 * surface renders this instead of a generic error line.
 */
export const CREDITS_EXHAUSTED_MESSAGE =
  "You're out of credits, so the server refused this request.\n\n" +
  'Plan credits refill on your renewal date. Top-up credits are one-time, never ' +
  'expire, and are only used once the plan credits are gone. Plans and packs are at ' +
  PRICING_URL +
  '.'
