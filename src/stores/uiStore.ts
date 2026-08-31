import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { SettingsTab } from '../lib/settings-reset'

export type View = 'chat' | 'models' | 'settings' | 'create' | 'benchmark'

/** Which collapsible section of the Settings page a deep link wants open.
 *  Only sections a hint elsewhere in the app sends people to. */
export type SettingsSection = 'comfyui'

/** Where a "go to Settings" button wants to land. Nebenbefund 3 of the R8
 *  re-measure: the ComfyUI empty state says "press Start under ComfyUI (Image
 *  & Video)", and that Start button sits inside a section that opens closed,
 *  so the last step of the route was a click the hint never mentioned. A
 *  button that already knows the tab can carry the section too. */
export interface SettingsFocus {
  tab: SettingsTab
  section?: SettingsSection
}

/** Which Cloud teaser sheet is open (Local-mode discovery, 2.5.8).
 *  'intent' = a locked Create tab (the cloud-only intents incl. the five
 *  2.5.8 categories); 'create-model' = a hosted model row in the Create
 *  picker (modelId = the tapped catalog id). The chat picker's Cloud rows
 *  open the CloudGateModal directly, no sheet there. */
export type CloudTeaserTarget =
  | {
      surface: 'intent'
      intent: 'upscale' | 'eraser' | 'character' | 'lipsync' | 'music' | 'extend' | 'motion'
    }
  | { surface: 'create-model'; kind: 'image' | 'video'; modelId: string }

/** Explorer panel geometry (2.6.6 C3). 280px is wide enough for a nested
 *  path, 200 is the floor where names stop being readable, and the ceiling is
 *  half the window so the panel can never eat the transcript. */
export const EXPLORER_DEFAULT_WIDTH = 280
export const EXPLORER_MIN_WIDTH = 200

/** Clamp a dragged width against the current window. Pure so the drag maths
 *  is testable without a DOM. */
export function clampExplorerWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return EXPLORER_DEFAULT_WIDTH
  const half = Math.floor((Number.isFinite(viewportWidth) ? viewportWidth : 0) / 2)
  const max = Math.max(EXPLORER_MIN_WIDTH, half)
  return Math.round(Math.min(Math.max(width, EXPLORER_MIN_WIDTH), max))
}

interface UIState {
  currentView: View
  sidebarOpen: boolean
  /** CloudGateModal (login, plan, beta gate), opened by the header's
   *  Cloud switch when the cloud side isn't usable yet. */
  cloudGateOpen: boolean
  /** CloudTeaserModal, null = closed. */
  cloudTeaser: CloudTeaserTarget | null
  /** The hosted model the user named on the way into cloud mode, by clicking
   *  its row in the local-mode picker. Read once by the mode rule when the
   *  flip lands, then cleared. Never persisted: it describes one click, not a
   *  preference. */
  pendingCloudModel: string | null
  /** Explorer panel width in px, persisted. */
  explorerWidth: number
  /** Explorer panel collapsed to its rail, persisted. */
  explorerCollapsed: boolean
  /** Read once by SettingsPage when it mounts, then cleared. Never persisted:
   *  it describes one navigation, not a preference. */
  settingsFocus: SettingsFocus | null
  setView: (view: View) => void
  /** Open Settings on a given tab, optionally with one section unfolded. */
  openSettingsAt: (focus: SettingsFocus) => void
  clearSettingsFocus: () => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setCloudGateOpen: (open: boolean) => void
  setCloudTeaser: (target: CloudTeaserTarget | null) => void
  setPendingCloudModel: (name: string | null) => void
  setExplorerWidth: (width: number, viewportWidth: number) => void
  setExplorerCollapsed: (collapsed: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      currentView: 'chat',
      sidebarOpen: true,
      cloudGateOpen: false,
      cloudTeaser: null,
      pendingCloudModel: null,
      explorerWidth: EXPLORER_DEFAULT_WIDTH,
      explorerCollapsed: false,
      settingsFocus: null,

      // Sidebar visibility follows the view: it's the conversation list, which
      // only makes sense in Chat. The hamburger toggle still works on other views;
      // it just resets to the view's default on the next setView() call.
      // A plain setView is somebody navigating by hand, so it drops any focus
      // a previous deep link left behind rather than firing it late.
      setView: (view) => set({ currentView: view, sidebarOpen: view === 'chat', settingsFocus: null }),

      openSettingsAt: (focus) =>
        set({ currentView: 'settings', sidebarOpen: false, settingsFocus: focus }),
      clearSettingsFocus: () => set({ settingsFocus: null }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setCloudGateOpen: (open) => set({ cloudGateOpen: open }),
      setCloudTeaser: (target) => set({ cloudTeaser: target }),
      setPendingCloudModel: (name) => set({ pendingCloudModel: name }),
      setExplorerWidth: (width, viewportWidth) =>
        set({ explorerWidth: clampExplorerWidth(width, viewportWidth) }),
      setExplorerCollapsed: (collapsed) => set({ explorerCollapsed: collapsed }),
    }),
    {
      name: 'locally-uncensored-ui',
      storage: safeJSONStorage(),
      // EXACTLY the two explorer fields (plan C3 / R1). This store was not
      // persisted at all before, and persisting it naively would carry
      // currentView and cloudGateOpen across restarts: the app would reopen on
      // whatever tab was left behind, or come up with the cloud gate on screen.
      partialize: (state) => ({
        explorerWidth: state.explorerWidth,
        explorerCollapsed: state.explorerCollapsed,
      }),
    },
  ),
)
