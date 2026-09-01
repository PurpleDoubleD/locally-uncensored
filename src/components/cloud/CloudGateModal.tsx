// The gate in front of the global Cloud mode. Opened by the header's purple
// Cloud switch whenever the cloud axis isn't usable yet.
//
// David 2026-07-11 redesign: a CENTERED, STEPPED flow instead of one crowded
// screen. Signed-out walks: (1) a "LU Cloud" hero with the hosted-GPU pitch,
// (2) the three plans to pick + "Stay on Local", with "Already got an account?"
// underneath → (3) the in-app sign-in. Every no-subscription state still offers
// back-to-Local or a plan (Hosted / Pro / Max → lu-labs.ai/pricing). The moment
// deriveCloudAvailable passes, the mode flips (via the one-time onboarding on
// the first flip). Payment stays on lu-labs.ai — the app never touches Stripe.

import { useEffect, useState } from 'react'
import { ExternalLink, HardDrive, RefreshCw, ArrowLeft, ArrowRight } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { useCloudAuth } from '../../hooks/useCloudAuth'
import { AccountPanel } from '../auth/AccountPanel'
import { CLOUD_BASE } from '../../api/cloud/config'
import { openExternal } from '../../api/backend'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'

const PLANS = [
  { anchor: 'hosted', name: 'Hosted', price: '€19' },
  { anchor: 'pro', name: 'Pro', price: '€49' },
  { anchor: 'max', name: 'Max', price: '€99' },
] as const

/** Three plan buttons → pricing in the browser. Price shown up front (monthly,
 *  EUR — mirrors lib/pricing on lu-labs.ai); the click still leaves for the
 *  browser to actually subscribe. */
function PlanGrid() {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PLANS.map((p) => (
        <button
          key={p.anchor}
          onClick={() => void openExternal(`${CLOUD_BASE}/pricing#${p.anchor}`)}
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

/** Deliberately big (David 2026-07-18): the way back to Local must be as
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

/** The LU monogram that headlines every step (David 2026-07-13: the stock
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

type Step = 'intro' | 'plans' | 'login'

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
  const available = deriveCloudAvailable({ user, licenseActive, access, quota })

  // Signed-out walkthrough position. Reset to the hero every time the gate
  // opens so a re-open never lands mid-flow.
  // The reset happens in the render where `open` flips, using React's
  // documented "adjust state while rendering" shape. As an effect it was a
  // cascading render (React 19 `set-state-in-effect`) that landed after paint,
  // so a re-open showed one frame of the step the gate was last left on.
  const [step, setStep] = useState<Step>('intro')
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setStep('intro')
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

  // Backing out of the gate drops the model the user named on the way in
  // (clicking an LU Cloud row in the local picker). It described that one
  // click, so it must not be lying in wait for the next flip, which could
  // happen minutes later and mean something else.
  const setPendingCloudModel = useUIStore((s) => s.setPendingCloudModel)
  const close = () => {
    setPendingCloudModel(null)
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

  const primaryBtn =
    'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.72rem] font-medium bg-lu-cloud text-white hover:opacity-90 transition-opacity'
  const ghostBtn =
    'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.72rem] font-medium border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors'
  const linkRow =
    'flex items-center justify-center gap-1 text-[0.68rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors'

  const signedOut = status === 'signed-out' || !user

  return (
    <Modal open={open} onClose={close} title="LU Cloud" hideHeader>
      {signedOut ? (
        step === 'intro' ? (
          <div className="space-y-5 pt-2">
            <CloudHero subtitle="Image, video, chat, code. On LU's hosted GPUs." />
            <div className="space-y-2 max-w-xs mx-auto">
              <button onClick={() => setStep('plans')} className={primaryBtn}>
                Get LU Cloud <ArrowRight size={13} />
              </button>
              <StayLocalButton onLocal={stayLocal} />
              {/* 2.6.3 B5: the sign-in entry used to exist ONLY on the plans
                  step, so a returning subscriber had to click a button that
                  reads like "buy" before finding a way to log in. It also made
                  the whole login path depend on that one step surviving any
                  change to where "Get LU Cloud" leads. It lives on both steps
                  now, which costs one link and removes that dependency. */}
              <button onClick={() => setStep('login')} className={linkRow + ' w-full pt-1'}>
                Already got an account? Sign in <ArrowRight size={11} />
              </button>
            </div>
          </div>
        ) : step === 'plans' ? (
          <div className="space-y-5 pt-2">
            <CloudHero subtitle="Pick a plan on lu-labs.ai. Payment stays in the browser." />
            <div className="space-y-3 max-w-xs mx-auto">
              <PlanGrid />
              <StayLocalButton onLocal={stayLocal} />
              <div className="pt-1 flex items-center gap-2">
                <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
                <span className="text-[0.6rem] text-gray-400 dark:text-gray-600">or</span>
                <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
              </div>
              <button onClick={() => setStep('login')} className={linkRow + ' w-full'}>
                Already got an account? Sign in <ArrowRight size={11} />
              </button>
            </div>
          </div>
        ) : (
          /* step === 'login' */
          <div className="space-y-4 pt-2">
            <CloudHero subtitle="Sign in with the account you subscribed with." />
            <div className="max-w-xs mx-auto">
              <AccountPanel />
              <button onClick={() => setStep('plans')} className={linkRow + ' w-full mt-3'}>
                <ArrowLeft size={11} /> Back to plans
              </button>
            </div>
          </div>
        )
      ) : !licenseActive ? (
        <div className="space-y-5 pt-2">
          <CloudHero />
          <div className="space-y-3 max-w-xs mx-auto">
            <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
              You're signed in as <span className="text-gray-900 dark:text-gray-100">{user.email ?? user.id}</span>,
              but this account has no active plan yet. LU Cloud is part of the paid plans.
            </p>
            <PlanGrid />
            <StayLocalButton onLocal={stayLocal} />
            <button className={ghostBtn} onClick={() => void refresh()}>
              <RefreshCw size={12} /> I subscribed, check again
            </button>
          </div>
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
            <p className="text-[0.72rem] text-center text-gray-600 dark:text-gray-400">
              Your plan is active, but it doesn't include a hosted compute credit
              budget, so there's nothing for Cloud mode to run on. Plans with
              cloud credits are on lu-labs.ai.
            </p>
            <button className={primaryBtn} onClick={() => void openExternal(`${CLOUD_BASE}/account`)}>
              <ExternalLink size={12} /> Open your account
            </button>
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
