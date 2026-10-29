// "What's new" sheet, shown once after an update (B4, 2026-08-04), and
// again whenever the user asks for it under Settings, Updates.
//
// Redesign (Bauer, 19.09.2026): the borrowed pulsing gradient square and the
// Sparkles icon are gone. The header carries the real house monogram from
// `layout/brand.ts`, the same vector every other surface in the app uses, so
// the sheet reads as part of the program instead of a shape pasted over it.
// The dialog itself now goes through the shared `ui/Modal`: a real dialog
// role, a focus trap that returns focus on close, Escape, and the app's own
// prefers-reduced-motion cascade, instead of a second hand-rolled copy of
// all four. The surface moves off the undocumented literal `#232323` onto
// the app's own near-black tokens (`lu-base`, `lu-canvas`), and the one
// accent colour is `lu-accent`, the house's own, not a plain Tailwind violet.
//
// Redesign, Runde 2 (Bauer, 19.09.2026): the frame above was fine, the prose
// inside it was not. Every line was a 40 to 90 word paragraph in developer
// language, always on screen, nothing about the sheet let a reader skim it.
// `release-notes.ts` now lets a line carry a short `title` next to its long
// `detail`; this file shows the title first and reveals the detail only once
// that one row is opened, instead of one global "show everything" switch.
// A line written before this pass has no title, so `itemTitle` falls back to
// the long text and that row renders exactly as it always did, no button, no
// chevron: nothing to click because there is nothing hidden behind it.
//
// `ReleaseNoteBody` is exported on its own so a test can render an arbitrary
// note (with or without `details`, with or without a `cloud` block) without
// wiring up every store this file reads from.

import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'
import { APP_VERSION as currentVersion } from '../../lib/app-version'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { useReleaseNotesStore, shouldShowReleaseNotes } from '../../stores/releaseNotesStore'
import { useHfLinkStore } from '../../stores/hfLinkStore'
import { releaseNoteFor, itemDetail, itemTitle, type ReleaseNote, type ReleaseNoteItem } from '../../lib/release-notes'

export function ReleaseNotesModal() {
  const lastNotesVersion = useReleaseNotesStore((s) => s.lastNotesVersion)
  const markNotesSeen = useReleaseNotesStore((s) => s.markNotesSeen)
  const reopened = useReleaseNotesStore((s) => s.reopened)
  const onboardingDone = useSettingsStore((s) => s.settings.onboardingDone)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const cloudAvailable = useCloudAuthStore(deriveCloudAvailable)

  // A Hugging Face link the user just clicked comes first: the sheet waits
  // until its question is answered instead of covering it (P9, Mac test of
  // 3.0.9: the first start after an update put the sheet on top of it).
  const hfLinkOpen = useHfLinkStore((s) => s.pending !== null || s.rejected !== null)
  const open = !hfLinkOpen && (reopened || shouldShowReleaseNotes(currentVersion, lastNotesVersion, onboardingDone))
  const note = releaseNoteFor(currentVersion)
  const close = () => markNotesSeen(currentVersion)

  /**
   * Der Knopf des Cloud-Blocks.
   *
   * Er tut genau das, was der Wolkenschalter im Kopf der App tut, und faellt
   * darum auf dieselbe Unterscheidung zurueck: ein Konto, das die Wolke nutzen
   * darf, wird umgeschaltet; jedes andere bekommt das Verkaufs-Panel. Kein
   * zweiter Weg in die Wolke, nur ein zweiter Ausloeser.
   *
   * Das Blatt schliesst sich dabei, sonst laege es ueber dem, was es gerade
   * geoeffnet hat. Es gilt danach als gelesen, denn der Kunde hat es gelesen.
   */
  const turnOnCloud = () => {
    close()
    if (cloudAvailable) updateSettings({ appMode: 'cloud' })
    else setCloudGateOpen(true)
  }

  if (!note) return null

  return (
    <Modal
      open={open}
      onClose={close}
      title={`What's new in ${note.version}`}
      hideHeader
      maxWidth="max-w-[420px]"
      panelPad="p-0"
    >
      <ReleaseNoteBody note={note} onClose={close} onTurnOnCloud={turnOnCloud} />
    </Modal>
  )
}

interface ReleaseNoteBodyProps {
  note: ReleaseNote
  onClose: () => void
  /** Absent when the note carries no `cloud` block; the button never renders then. */
  onTurnOnCloud?: () => void
}

/** A stable key for one row, independent of its (possibly edited) text. */
function rowKey(groupKey: string, index: number): string {
  return `${groupKey}:${index}`
}

/** The sheet's own content, independent of `Modal` and every store above it. */
export function ReleaseNoteBody({ note, onClose, onTurnOnCloud }: ReleaseNoteBodyProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const expandableKeys = useMemo(() => {
    const keys: string[] = []
    note.lines.forEach((item, i) => {
      if (itemTitle(item) !== itemDetail(item)) keys.push(rowKey('lines', i))
    })
    for (const section of note.details ?? []) {
      section.items.forEach((item, i) => {
        if (itemTitle(item) !== itemDetail(item)) keys.push(rowKey(section.title, i))
      })
    }
    return keys
  }, [note])

  const allExpanded = expandableKeys.length > 0 && expandableKeys.every((k) => expanded.has(k))

  const toggleRow = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleAll = () => {
    setExpanded(allExpanded ? new Set() : new Set(expandableKeys))
  }

  return (
    <div className="flex flex-col max-h-[calc(85vh/var(--ui-scale))] rounded-2xl overflow-hidden">
      {/* Header: the real monogram, never a Sparkles icon or a demo shape.
          Stays put while the body below scrolls, on the same near-black
          ground as the body, separated by one hairline rather than a
          visibly different panel. */}
      <div className="shrink-0 flex items-center gap-3 pl-5 pr-12 py-4 border-b border-white/[0.08]">
        <img
          src={MONOGRAM}
          alt=""
          width={28}
          height={28}
          className={`${MONOGRAM_INVERT} shrink-0`}
        />
        <h2 data-testid="release-heading" className="text-[0.85rem] font-semibold text-white leading-tight">
          {`What's new in ${note.version}`}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Vor allem anderen und fetter als der Rest (13.09.2026):
            wer aktualisiert, liest dieses Blatt einmal, und das Angebot
            gehoert an dessen Anfang statt zwischen die Fehlerbehebungen.
            Die drei Zeilen und der Satz kommen aus lib/cloud-pitch.ts,
            wortgleich mit dem Panel am Schalter. */}
        {note.cloud && (
          <div
            data-testid="release-cloud-block"
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3 space-y-2"
          >
            <p className="text-[0.55rem] font-semibold uppercase tracking-widest text-gray-400">
              Cloud
            </p>
            <ul className="space-y-1">
              {note.cloud.lines.map((line) => (
                <li key={line} className="text-[0.7rem] font-semibold leading-snug text-white">
                  {line}
                </li>
              ))}
            </ul>
            <p className="text-[0.62rem] leading-relaxed text-gray-300">{note.cloud.measured}</p>
            <p className="text-[0.62rem] leading-relaxed text-gray-300">{note.cloud.note}</p>
            <button
              onClick={onTurnOnCloud}
              className="w-full flex items-center justify-center h-8 rounded-lg bg-gray-900 !text-white hover:bg-gray-700 dark:bg-white dark:!text-black dark:hover:bg-gray-200 text-[0.7rem] font-semibold transition-colors"
            >
              Turn on Cloud
            </button>
          </div>
        )}

        {/* The two-sentence intro that used to sit under a separate "What is
            new" heading; the heading in the fixed header above already says
            that, so this is just the sentence, right under it in reading
            order. */}
        <p data-testid="release-intro" className="text-[0.7rem] leading-relaxed text-gray-300">
          {note.headline}
        </p>

        {/* Ein Textknopf ohne Flaeche bekommt vom Hausring ein ECKIGES
            Rechteck (der Ring folgt dem Radius, und der war 0). Eigene
            Polsterung plus `rounded-md`, nach aussen wieder
            herausgezogen, damit die Zeile an derselben Stelle steht wie
            vorher und der Ring rund um den Text liegt. */}
        {expandableKeys.length > 0 && (
          <button
            onClick={toggleAll}
            className="-mx-1.5 rounded-md px-1.5 py-0.5 text-[0.62rem] text-purple-700 hover:text-purple-900 dark:text-lu-accent dark:hover:text-lu-accent-hover transition-colors"
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        )}

        <ul className="space-y-1.5">
          {note.lines.map((item, i) => {
            const key = rowKey('lines', i)
            return (
              <ReleaseNoteRow
                key={key}
                item={item}
                expanded={expanded.has(key)}
                onToggle={() => toggleRow(key)}
              />
            )
          })}
        </ul>

        {note.details && note.details.length > 0 && (
          <div className="space-y-3">
            {note.details.map((section) => (
              <div key={section.title} className="space-y-1.5">
                {/* Auflage 2 (Bauer, 19.09.2026): war 0.6rem auf text-gray-500,
                    das ist 3,37:1 auf #202020 (bg-lu-base) und faellt unter
                    4,5:1. text-gray-300 auf derselben Flaeche misst 11,05:1,
                    die Groesse ist jetzt die vom Eigner verlangte Untergrenze
                    von 0.75rem.
                    Auflage 3 (Bauer, 21.09.2026): die Rubrik-Ueberschrift
                    hervorgehoben, der Inhaber wollte sie in Lila sehen. Derselbe
                    Hausakzent wie die Cloud-Pille und der primaere
                    Create-Knopf (`text-lu-accent`, schon zwei Zeilen weiter
                    oben in diesem Blatt am "Expand all"-Knopf im Einsatz),
                    kein neuer Farbwert. Diese Flaeche traegt bewusst kein
                    `.light`-Gegenstueck (siehe index.css, "Diese Leiter ist
                    DUNKEL"): `bg-lu-base` bleibt #202020 in beiden
                    App-Themes, also bleibt auch der Kontrast gleich, 6,27:1
                    gegen #a094f8, ueber der AA-Schwelle von 4,5:1 fuer
                    Fliesstext. Die Punkt-Titel darunter (ReleaseNoteRow)
                    bleiben unveraendert grau, nur die Rubrik selbst faerbt
                    um. */}
                <p className="text-xs font-semibold uppercase tracking-wide text-purple-700 dark:text-lu-accent">
                  {section.title}
                </p>
                <ul className="space-y-1.5">
                  {section.items.map((item, i) => {
                    const key = rowKey(section.title, i)
                    return (
                      <ReleaseNoteRow
                        key={key}
                        item={item}
                        expanded={expanded.has(key)}
                        onToggle={() => toggleRow(key)}
                      />
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-2 px-5 py-4 border-t border-white/[0.06]">
        {/* `data-autofocus`: das Blatt geht beim Start von selbst auf, also
            ohne vorherige Maus- oder Tastatureingabe. Der Browser wertet
            den Anfangsfokus dann als Tastaturfokus, und `ui/Modal` setzte
            ihn auf das erste Bedienelement im Blatt, also auf den kleinen
            Textknopf "Expand all" mitten im Fliesstext. Der stand damit
            beim Aufgehen in einem Fokusrahmen und las sich wie ein Fehler.
            Die Hausmechanik dafuer gibt es schon (dialog-a11y.ts, Regel 1):
            der Aufrufer sagt, welches Element den Anfangsfokus bekommt.
            Hier ist es die Hauptaktion des Blattes. */}
        <button
          data-autofocus
          onClick={onClose}
          className="flex-1 flex items-center justify-center h-9 rounded-lg bg-gray-900 !text-white hover:bg-gray-700 dark:bg-white dark:!text-black dark:hover:bg-gray-200 text-[0.72rem] font-semibold transition-colors"
        >
          Got it
        </button>
      </div>
    </div>
  )
}

interface ReleaseNoteRowProps {
  item: ReleaseNoteItem
  expanded: boolean
  onToggle: () => void
}

/**
 * One change line.
 *
 * An item with no `title` (every line written before this pass, and any line
 * nobody has rewritten yet) has nothing hidden behind it: `itemTitle` returns
 * the same text as `itemDetail`, so this renders as a plain line, exactly as
 * the sheet always has, no button and no chevron to click.
 *
 * An item with a `title` renders that short line as a keyboard-operable
 * disclosure button (`aria-expanded`, opens on click or Enter/Space, the
 * marker rotates) and only shows the long `detail` once it is opened.
 */
function ReleaseNoteRow({ item, expanded, onToggle }: ReleaseNoteRowProps) {
  const title = itemTitle(item)
  const detail = itemDetail(item)
  const hasDetail = title !== detail

  if (!hasDetail) {
    return (
      <li className="flex gap-2 text-[0.7rem] leading-relaxed text-gray-300">
        <span aria-hidden="true" className="mt-[0.5rem] w-1 h-1 rounded-full bg-gray-600 shrink-0" />
        <span>{title}</span>
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-start gap-1.5 text-left text-[0.7rem] leading-relaxed text-gray-300 hover:text-white transition-colors"
      >
        {/* [transform-box:fill-box] is load-bearing, not decoration (Bauer,
            19.09.2026, Auflage 1). This SVG is 11px, rendered from a 24x24
            viewBox: this app's browser defaults the CSS `rotate` property's
            reference box to `view-box` for an SVG element, and at that size,
            with that mismatch between the viewBox and the rendered box, it
            never paints the turn. That was the real bug behind the still,
            unrotated chevron: `getComputedStyle(...).rotate` read "90deg"
            and the `rotate-90` class was on the node both before and after
            this fix, so neither ever proved anything; only a geometry
            measurement of the chevron's own <path> did. Measured against
            the running dev server, collapsed vs. expanded, on the unfixed
            code: the path's own bounding box stayed 2.85 x 5.69px both
            times, upright, nothing moved. With `[transform-box:fill-box]`
            it becomes 6.32 x 3.16px once expanded, swapped, a real 90
            degree turn. Screenshots: r3-normal.png (collapsed) and
            r3-one-expanded.png / r3-expand-all.png (rotated); numbers and
            the negative control in whatsnew.md, Runde 3. */}
        <ChevronRight
          size={11}
          className={`mt-[0.3rem] shrink-0 text-gray-600 transition-transform [transform-box:fill-box] ${expanded ? 'rotate-90' : ''}`}
        />
        <span>{title}</span>
      </button>
      {/* Auflage 2 (Bauer, 19.09.2026): war 0.62rem auf text-gray-500, das
          ist 3,37:1 auf #202020 (bg-lu-base), unter 4,5:1 und unter der vom
          Eigner verlangten Untergrenze von 0.75rem. text-gray-300 auf
          derselben Flaeche misst 11,05:1. */}
      {expanded && (
        <p className="mt-1 pl-[18px] text-xs leading-relaxed text-gray-300">{detail}</p>
      )}
    </li>
  )
}
