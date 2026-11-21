/**
 * The frame of the mobile shell: stack of pages, tab bar or rail, sheets and
 * dialogs, toast, and the things that live as long as the app does.
 *
 * What the desktop keeps in AppShell and the phone needs too sits here:
 * the cloud account (useCloudAuth, exactly once), the model list of the built
 * in engine, the mode follow rule, the "out of credits" signal. What the
 * desktop has and a phone has not is simply absent: backend detection,
 * the onboarding window, shortcuts, title bar.
 */
import { useUpdateAtStart } from './screens/settings/parts/UpdateRow'
import { Component, useEffect, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import { MotionConfig } from 'framer-motion'
import { LucideProvider } from 'lucide-react'
import { useCloudAuth } from '../hooks/useCloudAuth'
import { useModels } from '../hooks/useModels'
import { CREDITS_EXHAUSTED_EVENT } from '../lib/credits-exhausted'
import { log } from '../lib/logger'
import { modelListIsStale } from '../lib/model-list-staleness'
import { useProviderStore } from '../stores/providerStore'
import { engineNoticesMounted } from './boot/engine-notices'
import type { BootInfo } from './boot/info'
import { ModelNotes } from './boot/ModelNotes'
import { StorageFallback } from './boot/StorageFallback'
import { useModeFollow } from './boot/mode-follow'
import { navApi } from './nav/api'
import { linkNoticesReady } from './nav/deeplink'
import { activeStack, showsTabBar } from './nav/core'
import { Overlays } from './nav/Overlays'
import { Stack } from './nav/Stack'
import { useNavStore } from './nav/store'
import { keyboardState, onKeyboardChange } from './platform/keyboard'
import { AgeGate } from './policy/AgeGate'
import { useAppLifecycle } from './platform/lifecycle'
import { currentOrientation, onOrientationChange } from './platform/viewport'
import { EngineNotices } from './resilience/EngineNotices'
import { FatalScreen } from './resilience/FatalScreen'
import { OfflineBanner } from './resilience/OfflineBanner'
import { ResumeNotice } from './resilience/ResumeNotice'
import { StorageToast } from './resilience/StorageToast'
import { useDownloadsBadge } from './screens/models/downloads-badge'
import { useSettingsServices } from './screens/settings/parts/services'
import { COMMON } from './strings/common'
import type { Tab } from './nav/types'
import { PageChromeContext, TabBar, ToastHost, toast, useToastStore } from './ui'

/** Stroke of the icons on the phone, in px (the desktop uses 1). */
export const MOBILE_ICON_STROKE_PX = 1.6

/** How long the app must have been away before a return refreshes account and models. */
const REFRESH_AFTER_MS = 30_000

class RootBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('mobile shell crashed', { error: String(error), stack: info.componentStack ?? '' })
  }

  render(): ReactNode {
    if (this.state.error) return <FatalScreen error={this.state.error} running />
    return this.props.children
  }
}

/** Account, model list and mode rule. Renders nothing; kept apart so their store updates do not repaint the frame. */
function AppServices() {
  const { refresh } = useCloudAuth()
  const { fetchModels } = useModels()
  useModeFollow()
  // Strand 5: the watch for a session that ended unasked (G6) and the notes of a new version (E21).
  useSettingsServices()
  // The open Android package has no store that tells it about a new version (lib/app-update.ts).
  useUpdateAtStart()

  useEffect(() => {
    // The models of the built in engine. No other local backend is asked.
    fetchModels().catch(() => {})
    // fetchModels is a new function on every render and always does the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // A provider with the user's own key was switched on, off or removed:
    // its models join or leave the list at once, not at the next app start.
    return useProviderStore.subscribe((state, before) => {
      if (state.providers === before.providers) return
      if (modelListIsStale(state.providers, before.providers)) fetchModels().catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useAppLifecycle({
    onForeground: (awayMs) => {
      if (awayMs < REFRESH_AFTER_MS) return
      // Also the fallback for a sign in whose deep link was lost: the account is asked again.
      void refresh()
      window.dispatchEvent(new CustomEvent('lu-models-refresh'))
    },
  })

  useEffect(() => {
    // A paid call ran out of credits: G5, where the call failed, never at start.
    const onExhausted = (event: Event) => {
      const top = navApi.getState().overlays.at(-1)
      if (top?.kind === 'sheet' && top.sheet === 'credits') return
      navApi.openSheet('credits', (event as CustomEvent<unknown>).detail)
    }
    window.addEventListener(CREDITS_EXHAUSTED_EVENT, onExhausted)
    return () => window.removeEventListener(CREDITS_EXHAUSTED_EVENT, onExhausted)
  }, [])

  return null
}

/**
 * The notices of the engine also keep its state current (which model is
 * loaded, for unloading on the way out of the app). Where no mounted page
 * draws them, an unseen copy does that job. It steps aside as soon as the
 * chat or the engine page is mounted, so no m-engine-notice id is in the
 * document twice (the copy used to be there always).
 */
function EngineNoticesKeeper() {
  const drawn = useNavStore((s) => engineNoticesMounted(activeStack(s).map((entry) => entry.route)))
  if (drawn) return null
  return (
    <div hidden>
      <EngineNotices />
    </div>
  )
}

const CHROME = { offlineBanner: <OfflineBanner /> }

/**
 * A tap on the tab bar leaves the page a toast spoke about. The toast goes with
 * it: on the next tab it lay where that page has its buttons ("Memory saved" on
 * "Download" in Models, check Android package 11, T1).
 */
function selectTab(tab: Tab): void {
  useToastStore.getState().dismiss()
  navApi.switchTab(tab)
}

function Frame({ boot }: { boot: BootInfo }) {
  const tab = useNavStore((s) => s.tab)
  const atRoot = useNavStore(showsTabBar)
  const covered = useNavStore((s) => s.overlays.length > 0)
  const orientation = useSyncExternalStore(onOrientationChange, currentOrientation, () => 'port' as const)
  const keyboardOpen = useSyncExternalStore(
    onKeyboardChange,
    () => keyboardState().open,
    () => false,
  )
  const downloads = useDownloadsBadge()

  useEffect(() => {
    if (boot.restoreFailed) toast(COMMON.restoreFailed, { tone: 'error', testid: 'restore-failed' })
  }, [boot.restoreFailed])

  // The frame is drawn: what a link wanted to say before that is said now (nav/deeplink.ts, G9).
  useEffect(() => {
    linkNoticesReady()
  }, [])

  // The bar shows on the four roots only, and never over an open keyboard.
  const tabBar = atRoot && !keyboardOpen
  return (
    <div
      className="m-app"
      data-testid="m-app"
      data-orient={orientation}
      data-covered={covered ? '' : undefined}
      data-tabbar={tabBar ? (orientation === 'land' ? 'rail' : 'bottom') : 'none'}
    >
      <StorageFallback />
      <div className="m-main">
        <Stack edgeSwipe={boot.edgeSwipe} />
        {tabBar ? (
          <div inert={covered} style={{ display: 'contents' }}>
            <TabBar active={tab} onSelect={selectTab} badges={{ models: downloads }} />
          </div>
        ) : null}
      </div>
      <Overlays />
      <ToastHost />
      <ModelNotes />
      <StorageToast />
      <ResumeNotice />
      <EngineNoticesKeeper />
    </div>
  )
}

export function MobileRoot({ boot }: { boot: BootInfo }) {
  return (
    <RootBoundary>
      <MotionConfig reducedMotion="user">
        <LucideProvider absoluteStrokeWidth strokeWidth={MOBILE_ICON_STROKE_PX}>
          <PageChromeContext.Provider value={CHROME}>
            {/* Nothing of the app starts before the age question is answered (policy/AgeGate). */}
            <AgeGate>
              <AppServices />
              <Frame boot={boot} />
            </AgeGate>
          </PageChromeContext.Provider>
        </LucideProvider>
      </MotionConfig>
    </RootBoundary>
  )
}
