/**
 * Cmd/Ctrl+K — die Kommandopalette (Audit Welle 3, Achse 11).
 *
 * Zwei Regeln haben die Form dieser Datei bestimmt:
 *
 * 1. KEIN zweiter Tastatur-Handler. Das Öffnen entscheidet
 *    `shortcutCommandFor` in `hooks/useKeyboardShortcuts.ts`, also dieselbe
 *    Besitz-Entscheidung, die auch Ctrl+N und Cmd+A regelt. Hierher kommt nur
 *    das Ereignis `lu-command-palette` — genau der Weg, den die
 *    Kürzel-Übersicht seit jeher geht (`lu-show-shortcuts`).
 * 2. KEINE nachgebauten Aktionen. Der Inhalt kommt aus
 *    `command-actions.ts`; jeder Eintrag trägt die Funktion, die auch am
 *    Knopf hängt.
 *
 * Dialogverhalten (Escape, Fokusfalle, Fokusrückgabe, `role="dialog"`,
 * Hintergrund inert) kommt vollständig von `ui/Modal` — hier steht davon
 * nichts nach, damit es auch nichts geben kann, was auseinanderläuft.
 * Darin sitzt das übliche Combobox-Paar: der Fokus bleibt im Suchfeld, die
 * Liste wird über `aria-activedescendant` geführt.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Modal } from './Modal'
import {
  buildCommands,
  matchCommands,
  resolveActiveIndex,
  type Command,
  type CommandContext,
  type Selection,
} from './command-actions'
import { nextFocusIndex } from './dialog-a11y'
import { SHORTCUT_ACTIONS, shortcutKeys } from '../../hooks/useKeyboardShortcuts'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { openCompare } from '../../stores/compareStore'
import { backendCall, isTauri } from '../../api/backend'

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<Selection>({ active: 0, forQuery: '' })
  const listRef = useRef<HTMLDivElement>(null)

  const setView = useUIStore((s) => s.setView)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setActiveModel = useModelStore((s) => s.setActiveModel)
  const models = useModelStore((s) => s.models)
  const activeModel = useModelStore((s) => s.activeModel)
  const appMode = useSettingsStore((s) => s.settings.appMode)

  useEffect(() => {
    const handler = () => { setQuery(''); setSelection({ active: 0, forQuery: '' }); setOpen(true) }
    window.addEventListener('lu-command-palette', handler)
    return () => window.removeEventListener('lu-command-palette', handler)
  }, [])

  const commands = useMemo<Command[]>(() => {
    const ctx: CommandContext = {
      shortcuts: SHORTCUT_ACTIONS,
      keysFor: shortcutKeys,
      setView,
      openCompare,
      toggleSidebar,
      setActiveModel,
      models,
      activeModel,
      // Models/Benchmark existieren im Cloud-Modus nicht (Header.tsx:301,
      // dazu der Umleitungs-Effekt in AppShell). Eine Palette, die trotzdem
      // dorthin führte, würde den Nutzer sofort wieder hinausbefördern.
      localViewsAvailable: appMode !== 'cloud',
      quit: isTauri() ? () => { void backendCall('exit_app') } : null,
    }
    return buildCommands(ctx)
  }, [setView, toggleSidebar, setActiveModel, models, activeModel, appMode])

  const shown = useMemo(() => matchCommands(query, commands), [query, commands])

  /**
   * Die tatsaechlich ausgewaehlte Zeile — ABGELEITET, nicht nachgepflegt.
   *
   * Hier standen vorher zwei Stuecke Buchfuehrung: ein Effekt, der beim
   * Tippen auf 0 zuruecksetzte (`react-hooks/set-state-in-effect`), und danach
   * eine Klemmung von Hand. Beide Faelle beantwortet jetzt
   * `resolveActiveIndex` in `command-actions.ts` — und zwar dort, wo sie ohne
   * DOM pruefbar sind. Die Auswahl merkt sich, zu WELCHER Anfrage sie gehoert;
   * damit ergibt sich das Zuruecksetzen von selbst und muss nicht bei jedem
   * Ereignis mitgeschrieben werden, das `query` aendert.
   */
  const activeIndex = resolveActiveIndex(selection, query, shown.length)

  /** Eine Zeile waehlen — immer zusammen mit der Anfrage, fuer die sie gilt. */
  const select = useCallback(
    (active: number) => setSelection({ active, forQuery: query }),
    [query],
  )

  const run = useCallback((cmd: Command) => {
    // Erst zu, dann ausführen. `ui/Modal` gibt beim Schließen den Fokus an das
    // auslösende Element zurück; liefe die Aktion vorher, würde diese Rückgabe
    // zum Beispiel „Focus chat input" sofort wieder überschreiben. Der Timer
    // wartet genau diesen Commit ab.
    //
    // Hier stand `requestAnimationFrame`, und das war falsch: in einem
    // Fenster, das gerade nicht sichtbar ist, feuert kein Animationsframe.
    // Live gemessen im verdeckten Fenster (2026-09-01) — die Palette ging zu
    // und der Befehl passierte NIE. Bei einer App, die sich beim Schließen in
    // den Tray legt, ist „verdeckt" kein Sonderfall. Ein Timer läuft auch
    // dann, notfalls gedrosselt, aber er läuft.
    setOpen(false)
    setTimeout(() => cmd.run(), 0)
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      select(Math.max(0, nextFocusIndex(shown.length, activeIndex, e.key === 'ArrowUp')))
      return
    }
    if (e.key === 'Home') { e.preventDefault(); select(0); return }
    if (e.key === 'End') { e.preventDefault(); select(Math.max(0, shown.length - 1)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = shown[activeIndex]
      if (cmd) run(cmd)
      return
    }
    // Escape steht hier BEWUSST nicht: es gehört dem Dialog-Stapel in
    // `ui/Modal`, und ein zweiter Escape-Pfad wäre genau der Fehler, den die
    // Kopfzeile von `useKeyboardShortcuts.ts` beschreibt.
  }

  // Den ausgewählten Eintrag im Blick behalten.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, shown])

  const listId = 'lu-command-list'
  const optionId = (i: number) => `${listId}-option-${i}`

  /**
   * Die Liste, wie sie gezeichnet wird: je Eintrag steht schon fest, ob eine
   * Gruppen-Ueberschrift davorgehoert.
   *
   * Hier stand eine Variable, die im `map` WAEHREND des Renderns
   * fortgeschrieben wurde (`lastGroup = cmd.group`). Das ist das Muster, das
   * der React-Compiler nicht mehr erlaubt (`react-hooks/immutability`) — und
   * es war auch der falsche Ort: ob ein Kopf davorgehoert, ist eine
   * Eigenschaft der LISTE und laesst sich ableiten, statt sie beim Zeichnen
   * mitzuzaehlen. Der Vergleich laeuft deshalb gegen den VORIGEN Eintrag;
   * damit braucht es gar keinen veraenderlichen Zwischenwert mehr, auch
   * keinen in einem anderen Scope versteckten.
   *
   * Gruppen-Ueberschriften gibt es nur in der ungefilterten Liste: sobald
   * gesucht wird, stehen die Treffer nach Guete und nicht mehr nach Gruppe,
   * und eine Ueberschrift koennte mehrfach auftauchen.
   */
  const rows = useMemo(() => {
    const showGroups = query.trim() === ''
    return shown.map((cmd, index) => ({
      cmd,
      index,
      head: showGroups && cmd.group !== shown[index - 1]?.group ? cmd.group : null,
    }))
  }, [shown, query])

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title=""
      hideHeader
      ariaLabel="Command palette"
      maxWidth="max-w-xl"
      panelRadius="rounded-xl"
      panelPad="p-0"
    >
      <div className="border-b border-gray-200 dark:border-white/10 px-3 py-2.5">
        <input
          type="text"
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search actions…"
          aria-label="Search actions"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown[activeIndex] ? optionId(activeIndex) : undefined}
          /* pr-10: `hideHeader` legt oben rechts den Schließen-Knopf des
             Dialogs ab, der sonst auf dem Text säße. */
          className="w-full bg-transparent pr-10 text-[0.8rem] text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-500 outline-none"
        />
      </div>

      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Actions"
        className="max-h-[19rem] overflow-y-auto scrollbar-thin py-1"
      >
        {shown.length === 0 && (
          <p className="px-3 py-6 text-center text-[0.7rem] text-gray-500">No matching action</p>
        )}

        {rows.map(({ cmd, head, index }) => {
          const isActive = index === activeIndex
          return (
            <div key={cmd.id}>
              {head && (
                <p className="px-3 pt-2 pb-1 text-[0.55rem] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  {head}
                </p>
              )}
              <div
                id={optionId(index)}
                role="option"
                aria-selected={isActive}
                data-active={isActive}
                onMouseMove={() => select(index)}
                /* Der Fokus bleibt im Suchfeld — sonst zerfällt das
                   Combobox-Paar und `aria-activedescendant` zeigt ins Leere. */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(cmd)}
                className={
                  'mx-1 flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-[0.72rem] ' +
                  (isActive
                    ? 'bg-gray-100 dark:bg-white/[0.08] text-gray-900 dark:text-white'
                    : 'text-gray-600 dark:text-gray-300')
                }
              >
                <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                {cmd.keys && (
                  <kbd className="shrink-0 rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[0.55rem] text-gray-500 dark:border-white/15 dark:text-gray-400">
                    {cmd.keys}
                  </kbd>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
