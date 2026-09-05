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

/**
 * Geometrie des Agenten-Panels (2.6.8).
 *
 * Schmaler als der Explorer: dort steht ein verschachtelter Pfad, hier eine
 * Zielzeile und ein Zustand. 240 statt 280, Boden 180.
 *
 * Die Klemme ist bewusst DIESELBE Rechnung wie beim Explorer und keine
 * gemeinsame Funktion mit zwei Parametersaetzen: die beiden Panels teilen
 * heute die Regel "nie mehr als das halbe Fenster", aber nicht ihren Grund.
 * Ein Explorer darf breit werden, weil Pfade lang sind; dieses Panel soll es
 * gar nicht wollen. Eine geteilte Funktion haette die zweite Begruendung
 * unsichtbar gemacht.
 */
export const AGENT_PANEL_DEFAULT_WIDTH = 240
export const AGENT_PANEL_MIN_WIDTH = 180

export function clampAgentPanelWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return AGENT_PANEL_DEFAULT_WIDTH
  const half = Math.floor((Number.isFinite(viewportWidth) ? viewportWidth : 0) / 2)
  const max = Math.max(AGENT_PANEL_MIN_WIDTH, half)
  return Math.round(Math.min(Math.max(width, AGENT_PANEL_MIN_WIDTH), max))
}

/**
 * Geometrie der Chatspalte links (D1, 02.09.2026).
 *
 * David: "Der left Sidepanel bei Chat Agent und Code ist Textmaessig als
 * Sessionname und Datum nicht sauber bis zum Ende durchgezogen bzw dynamisch
 * mit vergroesserung anpassend." Die erste Haelfte war der harte
 * `truncate(title, 30)` in der Zeile, den der CSS-Schnitt ersetzt hat. Die
 * zweite konnte gar nicht erfuellt sein: die Spalte war auf 250 px
 * festgenagelt, es gab also keine Vergroesserung, an die sich etwas haette
 * anpassen koennen. `--ui-scale` hilft nicht, denn `zoom` skaliert Kasten und
 * Text gemeinsam und aendert das VERHAELTNIS nicht.
 *
 * EIN DRITTEL statt der Haelfte, die Explorer und Agenten-Panel nehmen, und
 * das ist keine Nachlaessigkeit: die beiden sind ARBEITSFLAECHEN, ein
 * verschachtelter Pfad darf lang sein, eine Agentenzeile auch. Diese Spalte
 * ist NAVIGATION. Eine Navigation, die das halbe Fenster nimmt, hat den Zweck
 * verfehlt, fuer den man sie aufzieht.
 *
 * Dazu eine absolute Decke: ein Sitzungsname braucht nie mehr als 480 px, und
 * auf einem 4K-Schirm waere ein Drittel sonst ueber 1200 px, eine Zahl, die
 * nur entsteht, weil niemand sie aufgeschrieben hat.
 */
export const SIDEBAR_DEFAULT_WIDTH = 250
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 480

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  const third = Math.floor((Number.isFinite(viewportWidth) ? viewportWidth : 0) / 3)
  // Der Boden gewinnt gegen das Drittel: in einem sehr schmalen Fenster fiele
  // die Spalte sonst zusammen, und dann sind die Zeilen gar nicht mehr lesbar.
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(third, SIDEBAR_MAX_WIDTH))
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), max))
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
  /** Breite der Chatspalte links in px, persistiert. */
  sidebarWidth: number
  /** Agent panel width in px, persisted. */
  agentPanelWidth: number
  /** Agent panel collapsed to its rail, persisted. */
  agentPanelCollapsed: boolean
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
  setSidebarWidth: (width: number, viewportWidth: number) => void
  setAgentPanelWidth: (width: number, viewportWidth: number) => void
  setAgentPanelCollapsed: (collapsed: boolean) => void
  setExplorerWidth: (width: number, viewportWidth: number) => void
  setExplorerCollapsed: (collapsed: boolean) => void
}

/**
 * Wer von 2.6.7 kommt, verliert seine Gespraechsliste nicht.
 *
 * Gemessen am 05.09.2026 im gebauten Programm auf Windows: eine Installation
 * von 2.6.6 auf 2.6.8, danach das Feld `sidebarOpen` aus dem gespeicherten
 * Zustand entfernt, so wie es bei einem echten 2.6.7-Kunden aussieht.
 * Ergebnis nach dem Neuladen: 0 sichtbare Gespraechszeilen, 0 Loeschknoepfe.
 * Seine 109 Unterhaltungen waren vollstaendig da und keine davon zu sehen.
 *
 * Der Grund steht in beiden Baeumen nebeneinander. 2.6.7 hatte
 * `sidebarOpen: true` und speicherte den Wert NIE (`partialize` kannte dort
 * nur `explorerWidth` und `explorerCollapsed`). 2.6.8 speichert ihn und
 * startet mit `false`. Ein Kunde ohne abgelegten Wert bekommt also den neuen
 * Startwert, und niemand hat ihm gesagt, dass seine Chats hinter einem
 * unbeschrifteten Symbolknopf liegen.
 *
 * Diese Wanderung nimmt die Produktentscheidung NICHT vorweg: eine frische
 * Installation hat gar keinen gespeicherten Zustand, laeuft hier nie durch und
 * startet weiterhin schlank. Betroffen ist nur, wer schon einmal da war und
 * dessen Ansicht sonst still umspringen wuerde.
 *
 * Wer den Wert selbst gesetzt hat, behaelt ihn: das `in`-Pruefen unterscheidet
 * "nie abgelegt" von "auf false abgelegt", und nur der erste Fall wird
 * angefasst.
 */
export function migriereUiZustand(persisted: unknown, version: number): unknown {
  const alt = persisted as Partial<UIState> | undefined
  if (alt && version === 0 && !('sidebarOpen' in alt)) {
    return { ...alt, sidebarOpen: true }
  }
  return persisted
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      currentView: 'chat',
      // Collapsed by default, web parity (apps/web/stores/uiStore.ts:13-19):
      // the left column starts as a slim icon rail and the user expands it to
      // the full conversation list on demand. Unlike the web build this one is
      // persisted (see partialize), because a desktop app is not reloaded from
      // scratch on every visit and the choice should survive a restart.
      sidebarOpen: false,
      cloudGateOpen: false,
      cloudTeaser: null,
      pendingCloudModel: null,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      agentPanelWidth: AGENT_PANEL_DEFAULT_WIDTH,
      // Zugeklappt ist die Vorgabe: das Panel soll sich melden, wenn etwas
      // laeuft, und sonst keinen Platz nehmen.
      agentPanelCollapsed: true,
      explorerWidth: EXPLORER_DEFAULT_WIDTH,
      explorerCollapsed: false,
      settingsFocus: null,

      // Navigation no longer touches sidebarOpen. The conversation list only
      // makes sense in Chat, and that rule now lives in the Sidebar itself
      // (showSidebar), the way the web build does it. Forcing the panel open
      // here used to undo the user's collapse on every trip through Models or
      // Settings, which is exactly what the web parity round removes.
      // A plain setView is somebody navigating by hand, so it drops any focus
      // a previous deep link left behind rather than firing it late.
      setView: (view) => set({ currentView: view, settingsFocus: null }),

      openSettingsAt: (focus) =>
        set({ currentView: 'settings', settingsFocus: focus }),
      clearSettingsFocus: () => set({ settingsFocus: null }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setCloudGateOpen: (open) => set({ cloudGateOpen: open }),
      setCloudTeaser: (target) => set({ cloudTeaser: target }),
      setPendingCloudModel: (name) => set({ pendingCloudModel: name }),
      setSidebarWidth: (width, viewportWidth) =>
        set({ sidebarWidth: clampSidebarWidth(width, viewportWidth) }),

      setAgentPanelWidth: (width, viewportWidth) =>
        set({ agentPanelWidth: clampAgentPanelWidth(width, viewportWidth) }),
      setAgentPanelCollapsed: (collapsed) => set({ agentPanelCollapsed: collapsed }),
      setExplorerWidth: (width, viewportWidth) =>
        set({ explorerWidth: clampExplorerWidth(width, viewportWidth) }),
      setExplorerCollapsed: (collapsed) => set({ explorerCollapsed: collapsed }),
    }),
    {
      name: 'locally-uncensored-ui',
      storage: safeJSONStorage(),
      version: 1,
      migrate: migriereUiZustand,
      // What survives a restart is a stated PREFERENCE, never a leftover of
      // one session. currentView and cloudGateOpen stay out: the app would
      // otherwise reopen on whatever tab was left behind, or come up with the
      // cloud gate on screen.
      partialize: (state) => ({
        // The two explorer fields (plan C3 / R1).
        explorerWidth: state.explorerWidth,
        explorerCollapsed: state.explorerCollapsed,
        // Joined in the web-parity round: the rail-or-list choice is a stated
        // preference ("I want the rail" / "I want the list"), and the app
        // would forget it on every restart otherwise.
        sidebarOpen: state.sidebarOpen,
        // 2.6.8: die zwei Felder des Agenten-Panels. Geometrie ist eine
        // Vorliebe und ueberlebt einen Neustart; die AUFGABEN selbst tun das
        // ausdruecklich nicht (siehe agentTaskStore), ein wiederhergestelltes
        // "laeuft" waere eine Luege ueber den Zustand der Maschine.
        agentPanelWidth: state.agentPanelWidth,
        agentPanelCollapsed: state.agentPanelCollapsed,
        // Dieselbe Begruendung: eine gezogene Spaltenbreite ist eine Vorliebe.
        // Ohne diese Zeile waere jede Ziehbewegung beim naechsten Start
        // vergessen, der haeufigste Weg, so eine Funktion nutzlos zu machen.
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
)
