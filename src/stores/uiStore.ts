import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { SettingsTab } from '../lib/settings-reset'

export type View = 'chat' | 'models' | 'settings' | 'create' | 'benchmark' | 'voice' | 'neuron'

/** Which collapsible section of the Settings page a deep link wants open.
 *  Only sections a hint elsewhere in the app sends people to. */
export type SettingsSection = 'comfyui' | 'comfyui-nodes'

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
 * Der Inhaber: "Der left Sidepanel bei Chat Agent und Code ist Textmaessig als
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

/**
 * Schmales Fenster (Issue 309, T1, gemessen am 29.10.2026 im Release-Bau bei
 * 375x812).
 *
 * Die Klemmen oben liefen nur beim ZIEHEN. Ein Fenster, das schmal startet
 * oder schmal gezogen wird, behielt die gespeicherte Breite: die Chatspalte
 * blieb bei ~290 px und der Verlauf daneben wurde ein 30-px-Streifen, im
 * Code-Reiter blieb der Explorer offen und der Composer stapelte seine
 * Knoepfe senkrecht.
 *
 * Unter dieser Breite starten beide Seitenpanels zugeklappt. Das ist ein
 * Zustand des FENSTERS, keine Vorliebe: die gespeicherte Wahl fuer breite
 * Fenster liegt solange in `narrowStash`, `partialize` schreibt sie statt des
 * schmalen Werts, und beim Breiterwerden kommt sie zurueck. Wer im schmalen
 * Fenster ein Panel ausdruecklich aufklappt, bekommt es als Ueberlagerung
 * (Sidebar.tsx, ExplorerPanel.tsx), der Verlauf darunter behaelt seine Breite.
 * 640 ist die `sm`-Stufe von Tailwind, dieselbe Grenze, ab der die App
 * ueberhaupt zwei Spalten nebeneinander tragen will.
 */
export const NARROW_VIEWPORT_WIDTH = 640

/** Breite, die ohne echtes Fenster gilt (Node-Tests, erster Aufruf vor dem
 *  Einhaengen). Eine Desktop-Breite, damit nichts zuklappt, was niemand
 *  gemessen hat. */
const FALLBACK_VIEWPORT_WIDTH = 1280

export function readViewportWidth(): number {
  const w = typeof window !== 'undefined' ? window.innerWidth : undefined
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : FALLBACK_VIEWPORT_WIDTH
}

export function isNarrowViewport(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth < NARROW_VIEWPORT_WIDTH
}

/** Die Wahl fuer breite Fenster, waehrend das Fenster schmal ist. */
export interface NarrowStash {
  sidebarOpen: boolean
  explorerCollapsed: boolean
}

export interface ViewportSlice {
  viewportWidth: number
  sidebarOpen: boolean
  explorerCollapsed: boolean
  narrowStash: NarrowStash | null
}

/**
 * Rein, damit die Regel ohne DOM pruefbar ist. Klappt nur beim UEBERSCHREITEN
 * der Grenze, nie bei jedem Resize: wer im schmalen Fenster die Liste
 * aufklappt, dem klappt das naechste Pixel Breite sie nicht wieder zu.
 */
export function fitPanelsToViewport(state: ViewportSlice, viewportWidth: number): ViewportSlice {
  const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : FALLBACK_VIEWPORT_WIDTH
  if (isNarrowViewport(vw)) {
    if (state.narrowStash) return { ...state, viewportWidth: vw }
    return {
      viewportWidth: vw,
      sidebarOpen: false,
      explorerCollapsed: true,
      narrowStash: { sidebarOpen: state.sidebarOpen, explorerCollapsed: state.explorerCollapsed },
    }
  }
  if (!state.narrowStash) return { ...state, viewportWidth: vw }
  return {
    viewportWidth: vw,
    sidebarOpen: state.narrowStash.sidebarOpen,
    explorerCollapsed: state.narrowStash.explorerCollapsed,
    narrowStash: null,
  }
}

interface UIState {
  currentView: View
  sidebarOpen: boolean
  /** CloudGateModal (login, plan, beta gate), opened by the header's
   *  Cloud switch when the cloud side isn't usable yet. */
  cloudGateOpen: boolean
  /** CloudTeaserModal, null = closed. */
  cloudTeaser: CloudTeaserTarget | null
  /** The Cloud sheet's link has just switched the Cloud features off. Create
   *  says once where they are switched back on. Never persisted. */
  cloudHiddenNotice: boolean
  /** The hosted model the user named on the way into cloud mode, by clicking
   *  its row in the local-mode picker. Read once by the mode rule when the
   *  flip lands, then cleared. Never persisted: it describes one click, not a
   *  preference. */
  pendingCloudModel: string | null
  /** The LU Cloud line in Create was closed. Never persisted: it holds for
   *  this session, the next start may offer it again where a model does not
   *  fit. The switch in Settings ("Show Cloud features in Local mode") is
   *  the lasting way out. */
  cloudOfferDismissed: boolean
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
  /** Current window width in px (fitToViewport). Never persisted. */
  viewportWidth: number
  /** The wide-window choice while the window is narrow, see
   *  NARROW_VIEWPORT_WIDTH. Never persisted itself; partialize writes its
   *  values in place of the narrow ones. */
  narrowStash: NarrowStash | null
  /** Read once by SettingsPage when it mounts, then cleared. Never persisted:
   *  it describes one navigation, not a preference. */
  settingsFocus: SettingsFocus | null
  /** Counts the sends that were tried with no chat model picked. The model
   *  picker of the composer watches it: each step opens the picker, which says
   *  there what is missing. A counter and not a flag, so a second try opens it
   *  again. Never persisted: it describes one click, not a preference. */
  modelAskSeq: number
  askForModel: () => void
  /** Where Discover's chat downloads go for the next visit, when a button
   *  elsewhere already knows (the Neuron tweaker needs LU Engine files).
   *  Read once by Discover, then cleared. Never persisted. */
  discoverTarget: 'builtin' | null
  /** What Discover's search starts with on the next visit (N2: Neurons'
   *  "Get the original"). Read once by the Models page, then cleared. Never
   *  persisted. */
  discoverQuery: string | null
  /** Open Models on Discover's chat lane with downloads going to `target`,
   *  optionally searching for `query`. */
  openDiscoverFor: (target: 'builtin', query?: string) => void
  clearDiscoverTarget: () => void
  clearDiscoverQuery: () => void
  setView: (view: View) => void
  /** Open Settings on a given tab, optionally with one section unfolded. */
  openSettingsAt: (focus: SettingsFocus) => void
  clearSettingsFocus: () => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setCloudGateOpen: (open: boolean) => void
  setCloudTeaser: (target: CloudTeaserTarget | null) => void
  setCloudHiddenNotice: (shown: boolean) => void
  setPendingCloudModel: (name: string | null) => void
  setCloudOfferDismissed: (dismissed: boolean) => void
  setSidebarWidth: (width: number, viewportWidth: number) => void
  setAgentPanelWidth: (width: number, viewportWidth: number) => void
  setAgentPanelCollapsed: (collapsed: boolean) => void
  setExplorerWidth: (width: number, viewportWidth: number) => void
  setExplorerCollapsed: (collapsed: boolean) => void
  /** Re-fit the side panels to the window (AppShell, on mount and resize). */
  fitToViewport: (viewportWidth: number) => void
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
      // Collapsed by default, web parity (the web app):
      // the left column starts as a slim icon rail and the user expands it to
      // the full conversation list on demand. Unlike the web build this one is
      // persisted (see partialize), because a desktop app is not reloaded from
      // scratch on every visit and the choice should survive a restart.
      sidebarOpen: false,
      cloudGateOpen: false,
      cloudTeaser: null,
      cloudHiddenNotice: false,
      pendingCloudModel: null,
      cloudOfferDismissed: false,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      agentPanelWidth: AGENT_PANEL_DEFAULT_WIDTH,
      // Zugeklappt ist die Vorgabe: das Panel soll sich melden, wenn etwas
      // laeuft, und sonst keinen Platz nehmen.
      agentPanelCollapsed: true,
      explorerWidth: EXPLORER_DEFAULT_WIDTH,
      explorerCollapsed: false,
      viewportWidth: readViewportWidth(),
      narrowStash: null,
      settingsFocus: null,
      modelAskSeq: 0,
      askForModel: () => set((s) => ({ modelAskSeq: s.modelAskSeq + 1 })),
      discoverTarget: null,
      discoverQuery: null,
      openDiscoverFor: (target, query) => set({ currentView: 'models', settingsFocus: null, discoverTarget: target, discoverQuery: query?.trim() || null }),
      clearDiscoverTarget: () => set({ discoverTarget: null }),
      clearDiscoverQuery: () => set({ discoverQuery: null }),

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
      setCloudHiddenNotice: (shown) => set({ cloudHiddenNotice: shown }),
      setPendingCloudModel: (name) => set({ pendingCloudModel: name }),
      setCloudOfferDismissed: (dismissed) => set({ cloudOfferDismissed: dismissed }),
      setSidebarWidth: (width, viewportWidth) =>
        set({ sidebarWidth: clampSidebarWidth(width, viewportWidth) }),

      setAgentPanelWidth: (width, viewportWidth) =>
        set({ agentPanelWidth: clampAgentPanelWidth(width, viewportWidth) }),
      setAgentPanelCollapsed: (collapsed) => set({ agentPanelCollapsed: collapsed }),
      setExplorerWidth: (width, viewportWidth) =>
        set({ explorerWidth: clampExplorerWidth(width, viewportWidth) }),
      setExplorerCollapsed: (collapsed) => set({ explorerCollapsed: collapsed }),
      fitToViewport: (viewportWidth) =>
        set((state) => {
          const next = fitPanelsToViewport(state, viewportWidth)
          return next.viewportWidth === state.viewportWidth &&
            next.sidebarOpen === state.sidebarOpen &&
            next.explorerCollapsed === state.explorerCollapsed &&
            next.narrowStash === state.narrowStash
            ? state
            : next
        }),
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
        // Im schmalen Fenster die Wahl fuer breite Fenster, nicht der
        // erzwungene Zustand (NARROW_VIEWPORT_WIDTH): sonst kaeme nach einem
        // Neustart im breiten Fenster alles zugeklappt hoch.
        explorerCollapsed: state.narrowStash?.explorerCollapsed ?? state.explorerCollapsed,
        // Joined in the web-parity round: the rail-or-list choice is a stated
        // preference ("I want the rail" / "I want the list"), and the app
        // would forget it on every restart otherwise.
        sidebarOpen: state.narrowStash?.sidebarOpen ?? state.sidebarOpen,
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
