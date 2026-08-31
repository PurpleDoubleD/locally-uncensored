// The purple Cloud light-switch (header, right cluster, left of Downloads —
// David 2026-07-10, purple like the lu-labs.ai website). ON = the whole app
// runs on LU Cloud: hosted models everywhere, local-hardware surfaces hidden.
// Flipping ON only succeeds when the cloud axis is usable (signed in +
// licensed + beta gate + credit budget) — otherwise the CloudGateModal walks
// the account through login / the three plans. The very FIRST successful flip
// shows the one-time cloud onboarding instead of switching silently. Flipping
// OFF always works.

import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { cloudSwitchClick, CLOUD_ARM_TIMEOUT_MS } from '../../lib/cloud-switch-guard'
import { cn } from '../create/ui/cn'

export function CloudSwitch() {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const available = useCloudAuthStore(deriveCloudAvailable)
  const on = appMode === 'cloud'
  // First of the two clicks it takes to go INTO cloud. A stray click in this
  // corner of the header used to move the whole app to Cloud, pick a hosted
  // model silently, and bill the next question (Nebenbefund 4, R5 re-measure
  // 2026-08-30). See lib/cloud-switch-guard for why it is two clicks on this
  // one control and not a dialog.
  const [armedRaw, setArmed] = useState(false)
  // A mode change made anywhere else settles the switch too. That used to be
  // an effect writing `false` back into state after the fact (React 19
  // `set-state-in-effect`); "armed while already in cloud" is simply not a
  // state this switch has, so it is ruled out by the derivation instead — and
  // now on the same frame as the mode change rather than a paint later.
  const armed = armedRaw && !on

  // An armed switch goes back to sleep on its own, so it is never lying in
  // wait minutes later for a click that means something else entirely.
  // Keyed on the raw flag, not the derived one: the timer has to run down even
  // while the derivation is already hiding the armed state, or a mode change
  // made elsewhere would leave the flag standing indefinitely.
  useEffect(() => {
    if (!armedRaw) return
    const t = setTimeout(() => setArmed(false), CLOUD_ARM_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [armedRaw])

  const toggle = () => {
    switch (cloudSwitchClick({ on, available, armed })) {
      case 'leave-cloud':
        setArmed(false)
        updateSettings({ appMode: 'local' })
        return
      case 'open-gate':
        setCloudGateOpen(true)
        return
      case 'arm':
        setArmed(true)
        return
      case 'enter-cloud':
        setArmed(false)
        // The cloud onboarding modal was dropped in 2.5.9, the switch flips.
        updateSettings({ appMode: 'cloud' })
        return
    }
  }

  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label="Cloud"
      data-armed={armed ? 'true' : undefined}
      title={on
        ? "Cloud mode is on. Chat, image and video run on LU's hosted GPUs. Click to go back to Local."
        : armed
          ? 'Click again to move the whole app to Cloud. Answers are then billed to your lu-labs.ai credits.'
          : "Run LU on hosted GPUs with your lu-labs.ai account"}
      onClick={toggle}
      onBlur={() => setArmed(false)}
      className={cn(
        'flex items-center gap-1.5 pl-2 pr-1.5 py-[3px] rounded-full border transition-colors',
        on
          ? 'border-[#7c3aed] bg-[#7c3aed]/10 text-[#7c3aed] dark:text-[#a78bfa]'
          : armed
            ? 'border-[#7c3aed] bg-[#7c3aed]/10 text-[#7c3aed] dark:text-[#a78bfa] ring-1 ring-[#7c3aed]/40'
            : 'border-gray-200 dark:border-white/10 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-white/20',
      )}
    >
      <img
        src="/LU-monogram-bw.png"
        alt=""
        width={12}
        height={12}
        draggable={false}
        className="shrink-0 select-none dark:invert-0 invert"
      />
      {/* The armed switch says what the next click will do, in the place the
          finger already is. No transition on this text on purpose: the label
          has to change on the same frame as the click, or the first click
          looks like it did nothing at all (Nebenbefund 2, R10 re-measure).
          The testid is so a prober can read the state without guessing at
          class names, the way aria-checked reads the mode. */}
      <span
        data-testid="cloud-switch-label"
        data-state={armed ? 'armed' : on ? 'on' : 'off'}
        className="text-[0.65rem] font-medium leading-none"
      >
        {armed ? 'Switch to Cloud?' : 'Cloud'}
      </span>
      <span
        aria-hidden
        className={cn(
          'relative w-[22px] h-[12px] rounded-full transition-colors shrink-0',
          on ? 'bg-[#7c3aed]' : armed ? 'bg-[#7c3aed]/50' : 'bg-gray-300 dark:bg-white/15',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] w-[8px] h-[8px] rounded-full bg-white shadow-sm transition-[left]',
            on ? 'left-[12px]' : 'left-[2px]',
          )}
        />
      </span>
    </button>
  )
}
