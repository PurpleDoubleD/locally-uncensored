// A quiet line under "Install ComfyUI" for a small graphics card (funnel
// 3.1.0, Nr. 14). Until then the onboarding never named the cloud: a card with
// 8 GB or less was sent into a download of several gigabytes for video that
// then runs slowly or not at all, and LU Cloud came up only after that.
//
// It is a hint, not a fork: the install button stays the first choice, the
// line sits below it in the quiet text colour, and it shows only when the card
// is known and small. No card found (0) says nothing, because a failed
// detection is not a small card. The Mac never gets here (no ComfyUI there).
// "Show Cloud features in Local mode" switched off hides it like every other
// cloud hint in local mode.
//
// The link goes to the pricing page in the browser, tagged with where it came
// from (lib/cloud-links), and the click is counted (cloud_onboarding_hint).

import { useEffect, useState } from 'react'
import { Cloud } from 'lucide-react'
import { getMaxVramGb } from '../../lib/hardware'
import { cloudLink } from '../../lib/cloud-links'
import { openExternal, isMacOS } from '../../api/backend'
import { reportCloudGate } from '../../api/funnel'
import { useSettingsStore } from '../../stores/settingsStore'

/** At or below this many GB the hint shows. */
export const SMALL_CARD_GB = 8

/** Whether a card of this size gets the hint. Unknown (0 or less) does not. */
export function smallCard(vramGb: number): boolean {
  return vramGb > 0 && vramGb <= SMALL_CARD_GB
}

export function onboardingHintLine(vramGb: number): string {
  return `Your GPU has ${Math.round(vramGb)} GB. Images run on it. The bigger video models want 12 GB or more.`
}

export function OnboardingCloudHint() {
  const enabled = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const [vramGb, setVramGb] = useState(0)
  useEffect(() => {
    if (isMacOS()) return
    let alive = true
    void getMaxVramGb().then((gb) => { if (alive) setVramGb(gb) })
    return () => { alive = false }
  }, [])
  if (enabled === false || !smallCard(vramGb)) return null
  return (
    <p
      className="flex items-start gap-1.5 text-left t-micro leading-snug text-gray-500"
      data-testid="onboarding-cloud-hint"
    >
      <Cloud size={11} className="mt-[2px] shrink-0 text-lu-cloud dark:text-lu-cloud-lift" aria-hidden />
      <span>
        {onboardingHintLine(vramGb)}{' '}
        <button
          type="button"
          onClick={() => {
            reportCloudGate('cloud_onboarding_hint')
            void openExternal(cloudLink('/pricing', 'onboarding'))
          }}
          className="inline font-medium text-lu-cloud dark:text-lu-cloud-lift hover:underline underline-offset-2"
        >
          Run it in LU Cloud instead
        </button>
      </span>
    </p>
  )
}
