import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Menu, Loader2, Sun, Moon, RefreshCw, X, MoreVertical } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useCompareStore, openCompare } from '../../stores/compareStore'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
import { UpdateBadge } from './UpdateBadge'
import { DownloadBadge } from './DownloadBadge'
import { CloudSwitch } from '../cloud/CloudSwitch'
import { loadModel } from '../../api/ollama'
import { getProviderIdFromModel } from '../../api/providers'
import { ModelLoadError } from '../../lib/ollama-errors'
import { useModels } from '../../hooks/useModels'
import { useModelHealthStore } from '../../stores/modelHealthStore'
import { checkModelCapability } from '../../api/ollama'
import { closeDialog, isTopDialog, nextFocusIndex, openDialog } from '../ui/dialog-a11y'
import { MONOGRAM, MONOGRAM_INVERT } from './brand'
import type { View } from '../../stores/uiStore'

/**
 * Die Navigation als Daten, nicht als sechs abgeschriebene Knoepfe.
 *
 * Vorher stand jeder Eintrag zweimal im JSX — einmal in der Leiste, einmal im
 * Klappmenue — und „Compare" ausserdem zweimal in einer eigenen Fassung, weil
 * es keine View ist, sondern ein Modus. Vier Kopien fuer sechs Ziele. Jetzt
 * eine Liste; Leiste und Menue rendern beide daraus, und ein siebtes Ziel wird
 * an einer Stelle hinzugefuegt.
 *
 * `localOnly` ist der Grund, warum Benchmark und Models im Cloud-Modus fehlen:
 * beides misst oder verwaltet lokale Hardware und ist gegen gehostete GPUs
 * bedeutungslos (der AppShell-Waechter leitet dort ohnehin um).
 */
interface NavTarget {
  readonly id: string
  readonly label: string
  /** `null` = kein View-Wechsel, sondern der Compare-Modus. */
  readonly view: View | null
  readonly localOnly?: boolean
}

const NAV_TARGETS: readonly NavTarget[] = [
  { id: 'chat', label: 'Chat', view: 'chat' },
  { id: 'create', label: 'Create', view: 'create' },
  { id: 'compare', label: 'Compare', view: null },
  { id: 'benchmark', label: 'Benchmark', view: 'benchmark', localOnly: true },
  { id: 'models', label: 'Models', view: 'models', localOnly: true },
  { id: 'settings', label: 'Settings', view: 'settings' },
]

export function Header() {
  const { currentView, toggleSidebar, setView } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  const isComparing = useCompareStore((s) => s.isComparing)
  const activeModel = useModelStore((s) => s.activeModel)
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'unloading'>('idle')
  // Stale-manifest notice shown next to the Lichtschalter when Ollama rejects
  // the model with "does not support (chat|completion|generate)". Offers a
  // one-click refresh that re-pulls the model (progress tracked in DownloadBadge).
  const [staleError, setStaleError] = useState<{ model: string; message: string } | null>(null)
  const { pullModel, isPullingModel, fetchModels } = useModels()
  const healthStaleModels = useModelHealthStore((s) => s.staleModels)
  const addStaleToHealth = useModelHealthStore((s) => s.setStaleModels)
  const markHealthFresh = useModelHealthStore((s) => s.markFresh)
  const [showMoreMenu, setShowMoreMenu] = useState(false)

  // App-level model bootstrap. This used to ride on the header ModelSelector,
  // which sat here always-mounted; the picker has moved into the composer
  // (mounted only inside an active chat), so the header now owns the fetch.
  // Without it a fresh start never populates the list — and setModels' auto-
  // select of the first chat model never fires, so `activeModel` stays null and
  // New Chat dead-ends on the "pick a model" page. Refetch on provider changes
  // too (enable LM Studio / add a key in Settings), mirroring the old picker.
  useEffect(() => { fetchModels() }, [fetchModels])
  useEffect(() => {
    const unsub = useProviderStore.subscribe((state, prev) => {
      const changed = (Object.keys(state.providers) as Array<keyof typeof state.providers>)
        .some((id) => state.providers[id]?.enabled !== prev.providers[id]?.enabled
          || state.providers[id]?.baseUrl !== prev.providers[id]?.baseUrl)
      if (changed) fetchModels()
    })
    return () => unsub()
  }, [fetchModels])

  // Check if active model is an Ollama model
  const isOllamaModel = activeModel ? getProviderIdFromModel(activeModel) === 'ollama' : false
  const modelToUse = activeModel?.includes('::') ? activeModel.split('::')[1] : activeModel
  const isRefreshing = modelToUse ? isPullingModel(modelToUse) : false

  // Merge a single stale discovery into the shared health store so the top
  // banner and any Model Manager indicators update in lock-step with the
  // inline Lichtschalter chip.
  const syncStaleToStore = (name: string) => {
    const current = useModelHealthStore.getState().staleModels
    if (!current.includes(name)) addStaleToHealth([...current, name])
  }

  const handleLoad = async () => {
    if (!modelToUse || loadingState !== 'idle') return
    setStaleError(null)
    setLoadingState('loading')
    try {
      await loadModel(modelToUse)
      // If the store still thinks this model is stale (e.g. a scan ran before
      // the user re-pulled externally), clear it.
      markHealthFresh(modelToUse)
    } catch (e) {
      // Bug C (v2.4.5 — Anson192 GH #39): missing-blob errors get the same
      // one-click repair path as stale-manifest — `ollama pull <name>`
      // re-fetches missing blobs just like it refreshes stale manifests.
      if (e instanceof ModelLoadError && (e.kind === 'stale-manifest' || e.kind === 'missing-blob')) {
        setStaleError({ model: e.model, message: e.message })
        syncStaleToStore(e.model)
      }
    }
    finally { setLoadingState('idle') }
  }

  const handleRefreshStale = async () => {
    if (!staleError) return
    const name = staleError.model
    // pullModel wires into the DownloadBadge via useModels' activePulls store —
    // user sees progress in the header badge. After the pull completes,
    // verify via a cheap probe and then re-attempt the load automatically.
    try {
      await pullModel(name)
      const check = await checkModelCapability(name)
      if (check.ok) {
        markHealthFresh(name)
        setStaleError(null)
        setTimeout(() => { handleLoad() }, 200)
      }
      // If still not ok, keep the chip visible so the user can retry.
    } catch {
      // error stays visible — user can click Refresh again
    }
  }

  // When the startup health scan flags this model as stale, pre-populate the
  // chip so the user sees it WITHOUT having to click the broken toggle first.
  // Also clear the chip when the user switches to a fresh model, OR when the
  // chip was pinned to a DIFFERENT model than the one currently selected
  // (otherwise the red Lichtschalter and chip from the old stale model
  // leak onto the new fresh model).
  useEffect(() => {
    if (!modelToUse || !isOllamaModel) {
      if (staleError) setStaleError(null)
      return
    }
    const isStale = healthStaleModels.includes(modelToUse)
    if (isStale && !staleError) {
      setStaleError({
        model: modelToUse,
        message: `Model "${modelToUse}" has a stale manifest. Run "ollama pull ${modelToUse}" to refresh.`,
      })
    } else if (!isStale && staleError) {
      // User switched to a fresh model — drop the stale chip from the previous one.
      setStaleError(null)
    } else if (staleError && staleError.model !== modelToUse) {
      // Stale chip was for a different model; re-pin to the current one (it's stale too).
      setStaleError({
        model: modelToUse,
        message: `Model "${modelToUse}" has a stale manifest. Run "ollama pull ${modelToUse}" to refresh.`,
      })
    }
  }, [modelToUse, isOllamaModel, healthStaleModels, staleError])

  const toggleTheme = () => {
    updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
  }

  // ONE recipe for every nav item, in the bar and in the overflow menu alike:
  // a real click target instead of a 9px word, a filled rounded-md for the
  // active view so "where am I" survives a glance, and the idle/hover pair as
  // the only other state. Bare colour-only labels gave the active tab no hit
  // area and no boundary, which is why the row read as running text rather
  // than as navigation.
  //
  // D-T07: die Hoehe war 28px und stand damit neben, nicht auf der Leiter
  // (26/32/40). Gemessen am laufenden Fenster hatte diese Leiste fuenf
  // verschiedene Control-Hoehen nebeneinander — 19,73 / 20 / 21,98 / 22,99
  // und diese 28 —, keine einzige davon benannt. Die Reiter nehmen jetzt
  // --control-h-md, die Stufe, die index.css woertlich "default control
  // height" nennt.
  //
  // Zuordnung nach BEDEUTUNG, nicht nach naechstem Zahlenwert — genau wie
  // in der Sidebar (287903aa): --control-h-sm (26) ist das Mass der
  // Composer-Werkzeugleiste, und dass 26 naeher an 28 liegt als 32, ist
  // kein Argument. Dies ist die oberste Navigation der App in einer
  // 40px-Leiste; sie nimmt die Standardstufe und laesst 4px Luft nach oben
  // und unten.
  //
  // Die vier kleineren Hoehen dieser Leiste bleiben ungeaendert: es sind
  // reine Icon-Knoepfe, die ihre Hoehe aus dem Innenabstand ziehen, und
  // eine Leiter fuer Icon-Flaechen ist eine eigene Entscheidung — der
  // Befund steht im Bericht, nicht als halbe Aenderung hier.
  const NAV_BASE = 'flex items-center h-[var(--control-h-md)] px-2 rounded-md text-[0.68rem] font-medium transition-colors'
  // Aktiv = eine FLAECHE, in beiden Modi (D-A6 wollte das, hell hatte es nie).
  // Gemessen am laufenden Fenster: die aktive Pille war hell `bg-gray-100` auf
  // einer `bg-gray-100`-Leiste — derselbe Farbwert, Kontrast 1,000:1. Der
  // aktive Reiter war dort ueberhaupt keine Flaeche, sondern nur eine
  // Textfarbe. Mit der Leiste auf gray-200 (siehe <header> unten) traegt
  // Weiss die Pille:
  //     hell   #ffffff auf #e5e7eb  = 1,238:1
  //     dunkel white/8 ueber #141414 (= #272727) auf #141414 = 1,230:1
  // Zwei Modi, derselbe Abstand.
  const NAV_ACTIVE = 'bg-white dark:bg-white/[0.08] text-gray-900 dark:text-white'
  const NAV_IDLE = 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/[0.05]'
  const navClass = (active: boolean, full = false) =>
    `${full ? 'w-full text-left ' : ''}${NAV_BASE} ${active ? NAV_ACTIVE : NAV_IDLE}`

  /** Die sichtbaren Ziele in dieser Betriebsart. */
  const navTargets = NAV_TARGETS.filter((t) => !t.localOnly || settings.appMode !== 'cloud')
  const isNavActive = (t: NavTarget) =>
    t.view === null ? isComparing : currentView === t.view && !isComparing
  const goto = (t: NavTarget) => {
    if (t.view === null) { openCompare(); return }
    useCompareStore.getState().setComparing(false)
    setView(t.view)
  }

  /* ── Das Klappmenue (D-S21) ───────────────────────────────────────────────
     Befund: „Das Overflow-Menue ist kein Menue: Textzeilen ohne Padding, ohne
     Hover-Flaeche, ohne `role=menu`" — 0 `role=`-Treffer in dieser Datei,
     waehrend die Sidebar es richtig macht. Padding und Hover-Flaeche kamen mit
     dem Nav-Rezept (`bcec642b`); die Rollen und die Tastatur fehlten weiter.

     Gebaut wird das NICHT als drittes Muster, sondern nach dem, was
     `ui/ContextMenu.tsx` seit `f2650788` macht, und mit denselben Bausteinen
     aus `ui/dialog-a11y`:
       - `role="menu"` + `role="menuitem"`, Ausloeser mit `aria-haspopup`/
         `aria-expanded`
       - wanderndes `tabIndex` (nur der aktive Eintrag ist tabbar)
       - Pfeile/Home/End ueber `nextFocusIndex` — dieselbe zyklische Rechnung
         wie in der Fokusfalle der Modals
       - Escape ueber den Stapel (`isTopDialog`), damit ein Menue ueber einem
         Dialog nur sich selbst schliesst
       - Fokusrueckgabe an den Ausloeser beim Schliessen
     Ein `ContextMenu` direkt wiederzuverwenden ging nicht: dessen `MenuAction`
     kennt keinen Aktiv-Zustand, und die Navigation muss zeigen, wo man ist
     (`aria-current`). `ui/` gehoert in diesem Durchgang einem anderen Agenten,
     der Typ liess sich also nicht erweitern.
     ──────────────────────────────────────────────────────────────────────── */
  const menuId = useId()
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [menuActive, setMenuActive] = useState(0)

  const openMoreMenu = () => {
    setMenuActive(Math.max(0, navTargets.findIndex(isNavActive)))
    setShowMoreMenu(true)
  }
  const closeMoreMenu = (restoreFocus: boolean) => {
    setShowMoreMenu(false)
    if (restoreFocus) menuTriggerRef.current?.focus()
  }

  useEffect(() => {
    if (!showMoreMenu) return
    openDialog(menuId)
    const handlePointerDown = () => setShowMoreMenu(false)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      closeDialog(menuId)
    }
  }, [showMoreMenu, menuId])

  // Fokus dem ausgewaehlten Eintrag nachfuehren, solange das Menue offen ist.
  useEffect(() => {
    if (!showMoreMenu) return
    menuItemRefs.current[menuActive]?.focus()
  }, [showMoreMenu, menuActive])

  const onMenuKeyDown = (e: ReactKeyboardEvent) => {
    if (!isTopDialog(menuId)) return
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); e.stopPropagation(); closeMoreMenu(true); return
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        setMenuActive((i) => Math.max(0, nextFocusIndex(navTargets.length, i, e.key === 'ArrowUp')))
        return
      case 'Home':
        e.preventDefault(); setMenuActive(0); return
      case 'End':
        e.preventDefault(); setMenuActive(navTargets.length - 1); return
      case 'Tab':
        // Ein Menue faengt Tab nicht ein — es macht zu und gibt den Fokus
        // zurueck, so wie die Menues des Betriebssystems.
        e.preventDefault(); closeMoreMenu(true); return
      default:
    }
  }

  return (
    /* Die Leiste liegt hell jetzt auf gray-200, wie die Leinwand darunter
       (D-S42). Dunkel war das schon immer so — Kopfzeile und Leinwand teilen
       sich #141414 — hell standen sie auf zwei verschiedenen Werten, und die
       Kopfzeile war ausgerechnet die HELLERE, obwohl sie hinter allem liegt.
       Nebeneffekt, gemessen: die aktive Nav-Pille und die Hover-Flaeche der
       Fensterknoepfe waren beide `gray-100` auf `gray-100` und damit
       unsichtbar; sie haben jetzt Grund unter sich. */
    <header className="h-10 grid grid-cols-[auto_1fr_auto] items-center px-3 bg-gray-200 dark:bg-lu-canvas z-40 gap-4">
      {/* Left: Sidebar + Logo */}
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={toggleSidebar}
          className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 hover:text-gray-800 dark:hover:text-white transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu size={15} />
        </button>
        <button
          onClick={() => {
            useChatStore.getState().setActiveConversation(null)
            useCompareStore.getState().setComparing(false)
            setView('chat')
          }}
          className="flex items-center shrink-0 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition"
          aria-label="LU"
        >
          {/* Top-panel brand mark: the black/white monogram only (no wordmark),
              inverted per theme. Matches the web companion.
              D-A9: Vektorfassung statt 512px-PNG, und 20px statt 33px — die
              Groesse, die der Audit fuer diese Stelle nennt. Bei 33px stand
              dieselbe Grafik 39px unter der 18px-Fassung im Fensterbalken;
              20px nimmt den Groessensprung heraus, ohne das Zeichen zu
              verlieren. Warum Vektor: siehe `layout/brand.ts`. */}
          <img src={MONOGRAM} alt="" width={20} height={20} className={`${MONOGRAM_INVERT} opacity-80`} />
        </button>
      </div>

      {/* ── Mitte: die Navigation ─────────────────────────────────────────
          D-S19: „Rechts stehen 9 Elemente in `gap-2.5`, links nur Burger +
          Logo, der Center-Slot ist leer." Der Slot war leer, seit der
          Modellwaehler 2026-07-11 in den Composer gezogen ist; uebrig blieb
          der Stale-Chip, der fast nie da ist. Neun Dinge rechts, null in der
          Mitte.

          Die sechs Navigationsziele standen bis hierher rechts, zwischen dem
          Cloud-Schalter und dem Update-Badge. Sie sind jetzt hier. Das
          entlastet die rechte Gruppe auf vier Dienstprogramme UND fuellt den
          Slot auf JEDER View — nicht nur auf der einen, wo gerade ein Chip
          erscheint.

          D-S47: „Im Header klappen 6 Links ins Kebab-Menue, CloudSwitch/
          Download/Theme bleiben draussen — ohne erkennbare Regel." Die Regel
          gibt es jetzt, und sie ist an der Anordnung ablesbar statt nur
          gedacht: was in DIESER Gruppe steht, ist Navigation und klappt
          zusammen; was rechts steht, ist ein Zustandsanzeiger oder ein
          Schalter und klappt nie. Das Kebab steht deshalb hier, bei dem, was
          es aufnimmt, und nicht mehr drueben bei dem, was es nie aufnimmt. */}
      <nav aria-label="Main" className="flex items-center justify-center gap-2 min-w-0 shrink">
        {/* D-S20: EIN Breakpoint, nicht zwei. Vorher `xl` auf Create und `lg`
            ueberall sonst — dieselbe Leiste brach bei zwei verschiedenen
            Fensterbreiten, je nachdem, was gerade im Hauptbereich stand. Die
            Kopfzeile ist auf allen Views gleich breit und gleich voll; ihr
            Umbruch kann nicht von ihrem Inhalt abhaengen, weil der sich nicht
            aendert. `lg` (1024px) traegt die sechs Ziele mit Rand: sechs
            Beschriftungen in `px-2` plus Logo, Burger und vier
            Dienstprogramme kommen zusammen auf rund 570px. */}
        <div className="hidden lg:flex items-center gap-0.5">
          {navTargets.map((t) => (
            <button
              key={t.id}
              onClick={() => goto(t)}
              aria-current={isNavActive(t) ? 'page' : undefined}
              className={navClass(isNavActive(t))}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Dieselben Ziele, zusammengeklappt. Ein echtes Menue — siehe die
            Begruendung oben bei `menuId`. */}
        <div className="relative lg:hidden">
          <button
            ref={menuTriggerRef}
            onClick={() => (showMoreMenu ? closeMoreMenu(false) : openMoreMenu())}
            aria-haspopup="menu"
            aria-expanded={showMoreMenu}
            aria-label="Main navigation"
            className="p-1 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
            title="Navigation"
          >
            <MoreVertical size={16} />
          </button>

          {showMoreMenu && (
            <div
              role="menu"
              aria-label="Main navigation"
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={onMenuKeyDown}
              className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-40 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] shadow-xl z-50 flex flex-col gap-0.5 p-1.5"
            >
              {navTargets.map((t, i) => (
                <button
                  key={t.id}
                  ref={(el) => { menuItemRefs.current[i] = el }}
                  role="menuitem"
                  type="button"
                  tabIndex={i === menuActive ? 0 : -1}
                  aria-current={isNavActive(t) ? 'page' : undefined}
                  onMouseEnter={() => setMenuActive(i)}
                  onClick={() => { goto(t); closeMoreMenu(false) }}
                  className={navClass(isNavActive(t), true)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Model picker + Memory moved out of the header into the composer /
            top-right (web parity, David 2026-07-11). Only the stale-manifest
            warning still surfaces here — chat/code only, never Create. */}
        {currentView !== 'create' && isOllamaModel && staleError && (
          <div
            className="flex items-center gap-1 px-1.5 py-[2px] rounded-md bg-amber-500/10 border border-amber-400/30 text-[0.6rem]"
            title={staleError.message}
          >
            <span className="text-amber-600 dark:text-amber-300 font-medium">
              stale, refresh?
            </span>
            <button
              onClick={handleRefreshStale}
              disabled={isRefreshing}
              className="flex items-center gap-0.5 px-1 py-[1px] rounded text-amber-700 dark:text-amber-200 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
              title={`Re-pull ${staleError.model}`}
            >
              {isRefreshing ? (
                <Loader2 size={9} className="animate-spin" />
              ) : (
                <RefreshCw size={9} />
              )}
              <span>Refresh</span>
            </button>
            <button
              onClick={() => setStaleError(null)}
              className="flex items-center p-[1px] rounded text-amber-600/70 hover:text-amber-800 hover:bg-amber-500/20 transition-colors"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X size={9} />
            </button>
          </div>
        )}
      </nav>

      {/* ── Rechts: Dienstprogramme, und nur die ──────────────────────────
          Vier Dinge, die einen ZUSTAND zeigen oder umschalten: Cloud-Modus,
          laufende Downloads, Hell/Dunkel, verfuegbares Update. Keins davon ist
          ein Ziel, keins klappt je ins Kebab — das ist die andere Haelfte der
          Regel aus D-S47. Die Navigation, die hier stand, ist in die Mitte
          gezogen. */}
      <div className="flex items-center justify-end gap-2.5 min-w-0">
        {/* Purple Cloud light-switch (David 2026-07-10): left of Downloads,
            purple like the website. Gated: flipping ON without a usable
            account opens the CloudGateModal; the first successful flip runs
            the one-time cloud onboarding. */}
        <CloudSwitch />
        <DownloadBadge />

        <button
          onClick={toggleTheme}
          className="p-1 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          title={settings.theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          {settings.theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        <UpdateBadge />
      </div>
    </header>
  )
}
