// The gate in front of the global Cloud mode. Opened by the header's purple
// Cloud switch whenever the cloud axis isn't usable yet.
//
// 2026-09-13: OHNE Sitzung steht hier das Verkaufs-Panel, nicht mehr ein
// Anmeldefenster. Der abgemeldete Weg hat seitdem zwei Schritte statt drei:
//
//   (1) `CloudSalesPanel`. Was hinter dem Schalter liegt, in drei gezaehlten
//       Zeilen, mit dem Preis auf dem Knopf. Der Knopf geht in den Browser.
//   (2) die App-Anmeldung, erreichbar ueber den Textlink darunter, fuer den,
//       der schon zahlt.
//
// Der Zwischenschritt mit den drei Planknoepfen ist geloescht; sein Klick ging
// ohnehin auf dieselbe Preisseite. `PlanGrid` lebt weiter, denn ein
// ANGEMELDETES Konto ohne Plan sieht die Plaene unveraendert. Ausnahme seit
// 3.0.5: ist die Verlaengerung geplatzt (`pastDue`), steht dort der Satz aus
// `lib/past-due.ts` mit dem Weg zur offenen Rechnung, keine Planknoepfe.
//
// Jeder Zustand ohne Abo bietet weiter den Weg zurueck auf Local. Sobald
// deriveCloudAvailable durchgeht, kippt der Modus. Bezahlt wird auf
// lu-labs.ai, die App fasst keine Zahlung an.

import { useEffect, useState } from 'react'
import { ExternalLink, HardDrive, RefreshCw, ArrowLeft, ArrowRight, Check, LogIn } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { useCloudAuth } from '../../hooks/useCloudAuth'
import { AccountPanel } from '../auth/AccountPanel'
import { openExternal, isMacOS } from '../../api/backend'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'
import { CLOUD_SUBSCRIBER_LINE, cloudSalesLines } from '../../lib/cloud-pitch'
import { PAST_DUE_ACTION, pastDueLine } from '../../lib/past-due'
import { Hinweis } from '../ui/Hinweis'
import { cloudGateHeadline } from '../../lib/mac-pc-words'
import { GateModels } from './GateModels'
import { landOnGatePick } from '../../lib/cloud-gate-landing'
import { BuyChoice } from './BuyChoice'
import { reportCloudGate } from '../../api/funnel'
import { checkoutStartUrl, cloudLink, type CheckoutOrder, type CloudGateOpener, type CloudLinkMedium } from '../../lib/cloud-links'

const PLANS = [
  { anchor: 'hosted', name: 'Hosted', price: '€19' },
  { anchor: 'pro', name: 'Pro', price: '€49' },
  { anchor: 'max', name: 'Max', price: '€99' },
] as const

/** Three plan buttons → pricing in the browser. Price shown up front (monthly,
 *  EUR — mirrors lib/pricing on lu-labs.ai); the click still leaves for the
 *  browser to actually subscribe. Counted since 3.1.0 (cloud_gate_plan_click)
 *  and tagged with where it came from (lib/cloud-links). */
function PlanGrid() {
  const from = useUIStore((s) => s.cloudGateFrom)
  // Hosted is the subscription card of BuyChoice right above (3.1.0), so the
  // grid keeps the two bigger plans and does not offer Hosted twice.
  const bigger = PLANS.filter((p) => p.anchor !== 'hosted')
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="gate-plan-grid">
      {bigger.map((p) => (
        <button
          key={p.anchor}
          onClick={() => {
            reportCloudGate('cloud_gate_plan_click')
            void openExternal(cloudLink(`/pricing#${p.anchor}`, 'gate-plans', from))
          }}
          className="flex flex-col items-center gap-0.5 px-2 py-3 rounded-lg border border-lu-cloud/40 bg-lu-cloud/5 hover:bg-lu-cloud/15 transition-colors"
        >
          <span className="text-[0.8rem] font-semibold text-lu-cloud dark:text-lu-cloud-lift">{p.name}</span>
          <span className="text-[0.62rem] font-medium text-gray-500 dark:text-gray-400">
            {p.price}<span className="text-gray-400 dark:text-gray-500">/mo</span>
          </span>
        </button>
      ))}
    </div>
  )
}

/** One of the two buttons of the gate (signed out, or signed in without a
 *  plan): counted, then the checkout start with where it came from. */
function openGateCheckout(order: CheckoutOrder, src: 'app-gate-main' | 'app-gate-plans', medium: CloudLinkMedium, from: CloudGateOpener): void {
  reportCloudGate(order === 'sub' ? 'cloud_gate_main_sub' : 'cloud_gate_main_pack')
  void openExternal(checkoutStartUrl({ order, src, medium, opener: from }))
}

/** Deliberately big (2026-07-18): the way back to Local must be as
 *  unmissable as the plans, in every gate state. */
function StayLocalButton({ onLocal }: { onLocal: () => void }) {
  return (
    <button
      onClick={onLocal}
      className="w-full flex items-center justify-center gap-2 px-3 py-3 rounded-lg text-[0.85rem] font-semibold border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
    >
      <HardDrive size={15} /> Stay on Local
    </button>
  )
}

/**
 * A renewal payment failed and nothing else keeps the account running. The
 * gate says that, in the account panel's own sentence, and leads to the open
 * invoice. No plan buttons here: the server refuses a new plan (409) until the
 * invoice is settled. Paying happens on lu-labs.ai, the app takes no
 * payment.
 */
function PastDueNotice({ tier }: { tier: string | null }) {
  return (
    <div className="space-y-3" data-testid="cloud-gate-past-due">
      <Hinweis ton="fehler">{pastDueLine(tier)}</Hinweis>
      <button className={primaryBtn} onClick={() => void openExternal(cloudLink('/account', 'gate'))}>
        <ExternalLink size={12} /> {PAST_DUE_ACTION}
      </button>
    </div>
  )
}

// Die drei Knopfformen des Tors. Standen bis 3.0.0 im Rumpf der Komponente und
// mussten hoch, als das Verkaufs-Panel eine eigene Komponente wurde: zwei
// Knopfstile nebeneinander waeren genau der Stilbruch, den der Auftrag
// ausschliesst.
const primaryBtn =
  'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.72rem] font-medium bg-lu-cloud text-white hover:opacity-90 transition-opacity'
const ghostBtn =
  'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.72rem] font-medium border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors'
const linkRow =
  'flex items-center justify-center gap-1 text-[0.68rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors'

/**
 * Das Verkaufs-Panel, das der Wolkenschalter OHNE Sitzung zeigt (der Inhaber,
 * 13.09.2026).
 *
 * Bis hierher zeigte derselbe Klick ein Login-Fenster. Das ist die falsche
 * Frage an dieser Stelle: wer noch nichts gekauft hat, kann sich nicht
 * anmelden, und ein Anmeldefeld sagt ihm nicht, wofuer. Das Panel beantwortet
 * zuerst, was hinter dem Schalter liegt.
 *
 * Seit 3.1.0 (Funnel 13.11.2026):
 *   * Ganz oben, gut sichtbar, der Rueckweg fuer den, der schon gekauft hat
 *     (Nr. 11). Bis dahin stand er als kleiner Textlink unter dem Kaufknopf,
 *     und wer aus dem Browser zurueckkam, fand zuerst wieder das Angebot.
 *   * Statt eines Knopfs "19 EUR / month", der auf die Preisseite ging, zwei
 *     gleich grosse Wege: Abo und Paket ohne Abo (Nr. 4). Beide gehen auf
 *     die Kaufseite `/checkout/start`, nie direkt zum Zahlungsanbieter.
 *   * Jeder Klick hier wird gezaehlt (api/funnel.ts) und jeder Link sagt,
 *     woher er kommt (lib/cloud-links).
 *
 * Gekauft wird im Browser, nicht hier. Die App hat nie eine Zahlung
 * angefasst und faengt damit auch jetzt nicht an.
 *
 * Schlicht mit Absicht: dieselben Tailwind-Marken wie die uebrigen Dialoge,
 * derselbe Knopfstil, kein Verlauf, kein Leuchten, kein Emoji.
 */
function CloudSalesPanel({ onSignIn }: { onSignIn: () => void }) {
  const from = useUIStore((s) => s.cloudGateFrom)
  return (
    <div className="space-y-5 pt-2" data-testid="cloud-sales-panel">
      <button
        type="button"
        onClick={() => {
          reportCloudGate('cloud_gate_signin')
          onSignIn()
        }}
        className={ghostBtn + ' max-w-xs mx-auto'}
        data-testid="cloud-gate-signin-top"
      >
        <LogIn size={12} /> Already bought? Sign in
      </button>
      <div className="flex flex-col items-center text-center gap-2">
        <span className="text-[0.6rem] font-semibold uppercase tracking-widest text-lu-cloud dark:text-lu-cloud-lift">
          Cloud
        </span>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white max-w-xs">
          {cloudGateHeadline(isMacOS())}
        </h2>
        <p className="text-[12px] leading-relaxed text-gray-600 dark:text-gray-400 max-w-xs">
          Turn on Cloud to reach the full catalogue from any machine. Your local
          models keep working exactly as they do now.
        </p>
      </div>
      {/* Drei Zahlen, drei Zeilen. Jede kommt aus lib/cloud-pitch.ts und haengt
          ueber scripts/check-cloud-sales.mjs am Katalog im Web-Repo. */}
      <ul className="space-y-1.5 max-w-xs mx-auto" data-testid="cloud-sales-lines">
        {cloudSalesLines().map((line) => (
          <li
            key={line}
            className="flex items-start gap-2 text-[0.72rem] leading-snug text-gray-600 dark:text-gray-400"
          >
            <Check size={12} className="mt-[2px] shrink-0 text-lu-cloud" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {/* What the switch leads to, model by model (3.0.7). A click shows the
          two ways in; GateModels has the rest. */}
      <GateModels />
      <div className="space-y-2 max-w-xs mx-auto">
        <BuyChoice onPick={(order) => openGateCheckout(order, 'app-gate-main', 'gate', from)} />
        <p className="text-[0.62rem] leading-relaxed text-center text-gray-500 dark:text-gray-400">
          {CLOUD_SUBSCRIBER_LINE}
        </p>
        <button
          type="button"
          onClick={() => {
            reportCloudGate('cloud_gate_plan_click')
            void openExternal(cloudLink('/pricing', 'gate', from))
          }}
          className={linkRow + ' w-full'}
        >
          See all plans <ArrowRight size={11} />
        </button>
        <p className="text-[0.6rem] leading-relaxed text-center text-gray-400 dark:text-gray-500">
          Local mode stays free and offline.
        </p>
      </div>
    </div>
  )
}

/** The LU monogram that headlines every step (2026-07-13: the stock
 *  cloud glyph is gone from this flow — the black/white mark stands on its
 *  own, matching the one-time intro popup). */
function CloudHero({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-2">
      <img
        src={MONOGRAM}
        alt=""
        width={40}
        height={40}
        className={`${MONOGRAM_INVERT} opacity-90 select-none`}
        draggable={false}
      />
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white">LU Cloud</h2>
      {subtitle && (
        <p className="text-[12px] leading-relaxed text-gray-600 dark:text-gray-400 max-w-xs">{subtitle}</p>
      )}
    </div>
  )
}

/**
 * Der abgemeldete Weg hat seit 3.0.0 ZWEI Schritte, nicht drei.
 *
 * Der mittlere Schritt ("plans") zeigte die drei Plaene als Knopfreihe im
 * Fenster und schickte den Klick dann doch auf `/pricing`. Das Verkaufs-Panel
 * geht direkt dorthin, also war der Schritt nur noch eine Station, die nichts
 * entscheidet. Er ist geloescht, nicht auskommentiert. `PlanGrid` selbst bleibt:
 * die Zustaende fuer ein angemeldetes Konto ohne Plan zeigen es weiter.
 */
type Step = 'sales' | 'login'

export function CloudGateModal() {
  const open = useUIStore((s) => s.cloudGateOpen)
  const setOpen = useUIStore((s) => s.setCloudGateOpen)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const { refresh } = useCloudAuth()

  const status = useCloudAuthStore((s) => s.status)
  const user = useCloudAuthStore((s) => s.user)
  const licenseActive = useCloudAuthStore((s) => s.licenseActive)
  const access = useCloudAuthStore((s) => s.access)
  const quota = useCloudAuthStore((s) => s.quota)
  const pastDue = useCloudAuthStore((s) => s.pastDue)
  const pastDueTier = useCloudAuthStore((s) => s.pastDueTier)
  const available = deriveCloudAvailable({ user, licenseActive, access, quota })

  // Signed-out walkthrough position. Reset to the hero every time the gate
  // opens so a re-open never lands mid-flow.
  // The reset happens in the render where `open` flips, using React's
  // documented "adjust state while rendering" shape. As an effect it was a
  // cascading render (React 19 `set-state-in-effect`) that landed after paint,
  // so a re-open showed one frame of the step the gate was last left on.
  // A checkout that came back through the app's link (HfLinkInbox,
  // locallyuncensored://cloud/open?status=paid) opens the gate on the sign in:
  // the purchase is done, what is missing is the account in the app (Nr. 11).
  const checkoutReturn = useUIStore((s) => s.cloudGateReturn)
  const setCheckoutReturn = useUIStore((s) => s.setCloudGateReturn)
  const from = useUIStore((s) => s.cloudGateFrom)
  const [step, setStep] = useState<Step>(() => (open && checkoutReturn === 'paid' ? 'login' : 'sales'))
  const [wasOpen, setWasOpen] = useState(open)
  const [seenReturn, setSeenReturn] = useState(checkoutReturn)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setStep(checkoutReturn === 'paid' ? 'login' : 'sales')
  }
  if (seenReturn !== checkoutReturn) {
    setSeenReturn(checkoutReturn)
    if (checkoutReturn === 'paid') setStep('login')
  }

  // The moment the account clears every gate — already provisioned when the
  // gate opens, a fresh login, or a re-check after subscribing — flip the
  // global switch and get out of the way, via the one-time cloud onboarding on
  // the first successful flip. `open` MUST be a dependency (not the old wasOpen
  // ref): the one-time intro popup's "Sign in or create account" can open this gate
  // for a signed-in, fully provisioned user who's still in local mode. In that
  // case `available` was already true before the gate opened, so an effect
  // keyed only on `available` never re-runs — and the gate hangs forever on the
  // terminal "Checking your account…" state. Keying on `open` fires the flip
  // the instant the gate opens on an already-available account.
  useEffect(() => {
    if (open && available) {
      setOpen(false)
      // 2.5.9 dropped the cloud onboarding modal, so there is nothing to hand
      // off to — an available account just switches.
      updateSettings({ appMode: 'cloud' })
    }
  }, [open, available, setOpen, updateSettings])

  // A model clicked in this gate, maybe days ago and before a checkout in
  // the browser, is where the app lands the moment the account can use it,
  // whether or not the gate is open then (3.0.7, lib/cloud-gate-landing).
  useEffect(() => {
    if (available && landOnGatePick()) updateSettings({ appMode: 'cloud' })
  }, [available, updateSettings])

  // Backing out of the gate drops the model the user named on the way in
  // (clicking an LU Cloud row in the local picker). It described that one
  // click, so it must not be lying in wait for the next flip, which could
  // happen minutes later and mean something else.
  const setPendingCloudModel = useUIStore((s) => s.setPendingCloudModel)
  const close = () => {
    setPendingCloudModel(null)
    setCheckoutReturn(null)
    setOpen(false)
  }

  const stayLocal = () => {
    updateSettings({ appMode: 'local' })
    close()
  }

  // Re-probe on open — someone staring at this gate shouldn't wait for the
  // 5-minute background interval to clear a transient quota-fetch failure.
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const signedOut = status === 'signed-out' || !user

  return (
    <Modal open={open} onClose={close} title="LU Cloud" hideHeader>
      {signedOut ? (
        step === 'sales' ? (
          <CloudSalesPanel onSignIn={() => setStep('login')} />
        ) : (
          /* step === 'login' */
          <div className="space-y-4 pt-2">
            <CloudHero
              subtitle={checkoutReturn === 'paid'
                ? 'Thanks for your purchase. Sign in with the same account you used in the browser, and Cloud turns on.'
                : 'Sign in with the account you bought with.'}
            />
            <div className="max-w-xs mx-auto">
              <AccountPanel />
              {/* Zurueck fuehrt an die einzige Stelle, von der man hierher
                  kommt. Bis 3.0.0 zeigte diese Beschriftung auf den
                  Zwischenschritt, den es nicht mehr gibt. */}
              <button onClick={() => setStep('sales')} className={linkRow + ' w-full mt-3'}>
                <ArrowLeft size={11} /> Back
              </button>
            </div>
          </div>
        )
      ) : !licenseActive ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          {pastDue ? (
            <div className="space-y-3 max-w-xs mx-auto">
              <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
                You're signed in as <span className="text-gray-900 dark:text-gray-100">{user.email ?? user.id}</span>.
              </p>
              <PastDueNotice tier={pastDueTier} />
              <StayLocalButton onLocal={stayLocal} />
              <button className={ghostBtn} onClick={() => void refresh()}>
                <RefreshCw size={12} /> I paid, check again
              </button>
            </div>
          ) : (
            <div className="space-y-3 max-w-xs mx-auto">
              <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
                You're signed in as <span className="text-gray-900 dark:text-gray-100">{user.email ?? user.id}</span>,
                but this account has no active plan yet. LU Cloud runs on a subscription or on a credit pack.
              </p>
              <BuyChoice onPick={(order) => openGateCheckout(order, 'app-gate-plans', 'gate-plans', from)} />
              <PlanGrid />
              <GateModels />
              <StayLocalButton onLocal={stayLocal} />
              <button className={ghostBtn} onClick={() => void refresh()}>
                <RefreshCw size={12} /> I bought, check again
              </button>
            </div>
          )}
        </div>
      ) : !access ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          <div className="space-y-3 max-w-xs mx-auto">
            <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
              Your plan is active, but the server hasn't switched Cloud on for
              this account yet. Hit Check again in a moment, nothing to
              reinstall.
            </p>
            <StayLocalButton onLocal={stayLocal} />
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={12} /> Check again
            </button>
          </div>
        </div>
      ) : quota === null ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          <div className="space-y-3 max-w-xs mx-auto">
            <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
              Your plan is active, but your usage couldn't be loaded just now, so
              Cloud mode can't switch on yet. Check your connection and re-check.
            </p>
            <StayLocalButton onLocal={stayLocal} />
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={12} /> Check again
            </button>
          </div>
        </div>
      ) : quota.limits.credits <= 0 ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          <div className="space-y-3 max-w-xs mx-auto">
            {/* An unpaid account whose pack credits are gone lands here too
                (status active, tier starter, no budget). "Your plan is
                active" would be as untrue as "no active plan". */}
            {pastDue ? (
              <PastDueNotice tier={pastDueTier} />
            ) : (
              <>
                <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
                  Your plan is active, but it doesn't include a hosted compute credit
                  budget, so there's nothing for Cloud mode to run on. Plans with
                  cloud credits are on lu-labs.ai.
                </p>
                <button className={primaryBtn} onClick={() => void openExternal(cloudLink('/account', 'gate'))}>
                  <ExternalLink size={12} /> Open your account
                </button>
              </>
            )}
            <StayLocalButton onLocal={stayLocal} />
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={12} /> Check again
            </button>
          </div>
        </div>
      ) : (
        <div className="pt-2">
          <CloudHero subtitle="Checking your account…" />
        </div>
      )}
    </Modal>
  )
}
