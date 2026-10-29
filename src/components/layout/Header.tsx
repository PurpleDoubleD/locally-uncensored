import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { yieldSilentLocalRuns } from '../../lib/silent-runs'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
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
import { log } from '../../lib/logger'
import { getProviderIdFromModel } from '../../api/providers'
import { ModelLoadError } from '../../lib/ollama-errors'
import { useModels } from '../../hooks/useModels'
import { useModelHealthStore } from '../../stores/modelHealthStore'
import { checkModelCapability } from '../../api/ollama'
import { closeDialog, isTopDialog, nextFocusIndex, openDialog } from '../ui/dialog-a11y'
import { MONOGRAM, MONOGRAM_INVERT } from './brand'
import type { View } from '../../stores/uiStore'
import { modelListIsStale, openaiEntriesAreStale } from '../../lib/model-list-staleness'

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
  // Voice has no cloud service yet, so with the Cloud switch on it goes the
  // way Benchmark and Models go.
  { id: 'voice', label: 'Voice', view: 'voice', localOnly: true },
  { id: 'compare', label: 'Compare', view: null },
  { id: 'benchmark', label: 'Benchmark', view: 'benchmark', localOnly: true },
  // The Neuron tweaker (3.0.9, P11) steers local LU Engine models only.
  { id: 'neuron', label: 'Neurons', view: 'neuron', localOnly: true },
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
  // Models whose stale chip the user dismissed this session (Posten 3,
  // bau/review-lanes.md "Runde 3 der Pruefung": lu-300-desktop 1f19b7b8,
  // ported here because the two repos' Header.tsx have since diverged too
  // far for a clean cherry-pick). Without this list the X below only clears
  // local state, and the effect two below rebuilds the chip from the health
  // store in the very same pass, so the click did nothing a user could see.
  const [dismissedStale, setDismissedStale] = useState<string[]>([])
  const { pullModel, isPullingModel, fetchModels } = useModels()
  const healthStaleModels = useModelHealthStore((s) => s.staleModels)
  const addStaleToHealth = useModelHealthStore((s) => s.setStaleModels)
  const markHealthFresh = useModelHealthStore((s) => s.markFresh)
  const [showMoreMenu, setShowMoreMenu] = useState(false)

  // App-level model bootstrap. This used to ride on the header ModelSelector,
  // which sat here always-mounted; the picker has moved into the composer
  // (mounted only inside an active chat), so the header now owns the fetch.
  // Without it a fresh start never populates the list, setModels' auto-select
  // of the first chat model never fires, `activeModel` stays null and New Chat
  // dead-ends on the "pick a model" page. Refetch on provider changes too
  // (enable LM Studio in Settings, hand the shared slot to another backend),
  // mirroring the old picker. Welche Aenderung das ist, steht an genau einer
  // Stelle (lib/model-list-staleness); sie stand hier und im Waehler
  // wortgleich zweimal und kannte in beiden Fassungen `managed` nicht.
  useEffect(() => { fetchModels() }, [fetchModels])
  useEffect(() => {
    const unsub = useProviderStore.subscribe((state, prev) => {
      if (modelListIsStale(state.providers, prev.providers)
        || openaiEntriesAreStale(state.openaiEntries, prev.openaiEntries)) fetchModels()
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
    // A backend cannot swap a model that is still computing (lib/silent-runs.ts).
    yieldSilentLocalRuns()
    try {
      await loadModel(modelToUse)
      // If the store still thinks this model is stale (e.g. a scan ran before
      // the user re-pulled externally), clear it.
      markHealthFresh(modelToUse)
    } catch (e) {
      // Bug C (v2.4.5 — GH #39): missing-blob errors get the same
      // one-click repair path as stale-manifest — `ollama pull <name>`
      // re-fetches missing blobs just like it refreshes stale manifests.
      if (e instanceof ModelLoadError && (e.kind === 'stale-manifest' || e.kind === 'missing-blob')) {
        setStaleError({ model: e.model, message: e.message })
        syncStaleToStore(e.model)
      } else {
        // This load has no control of its own on screen (it only follows a
        // re-pull), so there is nothing to show. It ends at loadModel's limit.
        log.warn('[header] reloading the model after a re-pull did not finish', { model: modelToUse, err: e })
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
    // Dismissed this session: stay hidden even though the health store still
    // lists the model as stale. Checked BEFORE the re-pin branches below, so
    // switching away and back to this same model does not resurrect it.
    if (isStale && dismissedStale.includes(modelToUse)) {
      if (staleError) setStaleError(null)
      return
    }
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
  }, [modelToUse, isOllamaModel, healthStaleModels, staleError, dismissedStale])

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
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const moreMenu = usePopoverPlatz(moreMenuRef, showMoreMenu, { abstand: 8 })
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
       unsichtbar; sie haben jetzt Grund unter sich.

       D-T-Mitte (18.09.2026): Spalten waren `auto_1fr_auto`. Die Mitte-Spalte
       war damit der REST zwischen zwei ungleich breiten Aussenspalten (links
       Burger+Logo ~59px, rechts vier Werkzeuge ~178px), und `justify-center`
       zentriert nur INNERHALB dieser Restflaeche, nicht im Fenster. Gemessen
       am laufenden Fenster stand die Reihe deshalb 59,7px links vom Fenster-
       und Leistenmittelpunkt, bei jeder Breite und in Cloud wie Lokal gleich
       weit, weil die Differenz allein aus den Aussenspalten kommt, nicht aus
       dem Inhalt der Mitte. Der A/B-Vergleich zentriert sein "VS" seinerseits
       im Inhaltsbereich (Compare blendet die Seitenleiste aus, `AppShell.tsx`:
       `{!isComparing && <Sidebar />}`), und der liegt bei symmetrischem
       `p-2` im Fenster mittig, also ist die Fenstermitte hier dieselbe Achse
       wie die VS-Achse.

       Jetzt `1fr_auto_1fr`: die Mitte ist eine dritte, eigene Spalte, die sich
       auf ihren Inhalt einmisst und ZWISCHEN zwei GLEICH GROSSEN Restspalten
       liegt, damit liegt sie automatisch auf der Fenstermitte, unabhaengig
       davon, wie breit links und rechts sind. Links und rechts behalten ihre
       Spalte (jetzt `1fr` statt `auto`) und dehnen sich damit, aber ihr
       Inhalt bleibt an derselben Kante stehen wie vorher (links `justify-
       start`, rechts unten `justify-end` sind schon gesetzt), nachgemessen
       um 0,0px Differenz zur alten Position.

       Runde 2 (Auflage 1, 19.09.2026): der enge Fall war nicht der gemessene.
       Compare zeigt rechts nur drei ruhige Werkzeuge (~170px), Chat kann dort
       zusaetzlich den Stale-Chip UND das Update-Badge tragen (~470px). Beide
       Aussenspalten trugen `min-w-0`, also durfte die rechte Spalte auf ihren
       1fr-Anteil (~281px bei 1024px Fensterbreite) schrumpfen, OHNE dass ihr
       Inhalt mitschrumpfte: ein `<div>` ohne eigenes `flex-shrink` auf den
       Kindern bleibt bei seiner natuerlichen Breite und lief links aus der
       eigenen Spalte heraus, direkt in die letzten Reiter hinein (nachgemessen
       Ueberlappung bei 1024/1100/1280px, `e2e/topnav-centering.spec.ts`,
       "chat view with stale chip and update badge"). `min-w-0` runter von der
       rechten Spalte (Zeile unten): jetzt ist ihre automatische Mindestbreite
       ihr eigener Inhalt, die Spalte kann nicht mehr enger werden als das, was
       darin steht. Nebeneffekt bei diesem seltenen Zusammentreffen: die
       Reitergruppe weicht dann von der Fenstermitte ab (die linke Spalte
       bleibt schmal, die rechte nimmt sich, was sie braucht), das ist die
       Abwaegung, kein Fehler: nichts ueberlappt mehr und nichts wird
       abgeschnitten, und im normalen Fall (keine der beiden Ausnahmen sichtbar)
       bleibt die Zentrierung bei 0px, weil der Inhalt dann so oder so unter dem
       1fr-Anteil liegt. */
    <header className="h-10 grid grid-cols-[1fr_auto_1fr] items-center px-3 bg-gray-200 dark:bg-lu-canvas z-40 gap-4">
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
        {/* Rollback 2.6.9 (Discord, 07.09.2026): „when the tools move I have
            to look for them." Zwischen 2.6.8 und hier stand an dieser Stelle
            ein Scrollrad, das den aktiven Reiter in die Mitte fuhr und die
            Nachbarn nach aussen ausblendete. Damit stand kein Ziel zweimal an
            derselben Stelle, und am Rand war immer etwas angeschnitten. Es ist
            wieder die Reihe aus 2.6.7: sechs feste Eintraege, alle gleich
            hell, jeder immer an seinem Platz. */}
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
              ref={moreMenuRef}
              style={moreMenu.style}
              className={`absolute left-1/2 -translate-x-1/2 w-40 rounded-lg lu-elevated z-50 flex flex-col gap-0.5 p-1.5 overflow-y-auto scrollbar-thin ${moreMenu.nachOben ? 'bottom-full mb-2' : 'top-full mt-2'}`}
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

      </nav>

      {/* ── Rechts: Dienstprogramme, und nur die ──────────────────────────
          Vier Dinge, die einen ZUSTAND zeigen oder umschalten: Cloud-Modus,
          laufende Downloads, Hell/Dunkel, verfuegbares Update. Keins davon ist
          ein Ziel, keins klappt je ins Kebab — das ist die andere Haelfte der
          Regel aus D-S47. Die Navigation, die hier stand, ist in die Mitte
          gezogen. */}
      <div className="flex items-center justify-end gap-2.5">
        {/* Der Stale-Hinweis stand bis 04.09.2026 in der Mitte-Gruppe und
            schob die Navigation zur Seite, sobald er auftauchte. Er gehoert
            ohnehin hierher: er zeigt einen ZUSTAND, und das ist genau die
            Regel dieser Gruppe. Model picker und Memory sind 2026-07-11 in
            den Composer gezogen (Web-Paritaet); nur diese Warnung ist hier
            geblieben, Chat und Code, nie Create. */}
        {currentView !== 'create' && isOllamaModel && staleError && (
          <div
            className="flex items-center gap-1 t-micro text-gray-500 dark:text-gray-400"
            title={staleError.message}
          >
            <span>stale</span>
            <button
              onClick={handleRefreshStale}
              disabled={isRefreshing}
              className="flex items-center gap-0.5 rounded px-1 py-[1px] hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
              title={`Re-pull ${staleError.model}`}
            >
              {isRefreshing ? <Loader2 size={9} className="animate-spin" /> : <RefreshCw size={9} />}
              <span>Refresh</span>
            </button>
            <button
              onClick={() => {
                setDismissedStale((d) => (staleError && !d.includes(staleError.model) ? [...d, staleError.model] : d))
                setStaleError(null)
              }}
              className="flex items-center rounded p-[1px] hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X size={9} />
            </button>
          </div>
        )}

        {/* Purple Cloud light-switch (2026-07-10): left of Downloads,
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
