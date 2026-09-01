import { useEffect, useState } from 'react'
import { formatElapsed } from '../../lib/format-elapsed'

interface Props {
  isRunning: boolean
  /** What the run is actually doing right now. Defaults to "Working"; pass
   * something specific ("Waiting for your approval", "Generating image")
   * whenever the surface knows better, because a wait that looks like work
   * is how a nine minute approval stall got mistaken for progress (G15b). */
  label?: string
}

/**
 * THE bottom-of-run status line (G14-6, David 2026-08-07): the word "Working"
 * carrying the same shimmer as a live tool name, with the elapsed clock
 * beside it. It replaces the three bouncing dots AND the floating
 * bottom-right counter on every surface (Chat, Agent, Code), so a run has
 * exactly one anchor that says the app is alive, what it is doing, and for
 * how long. Reference is the Claude desktop app.
 */
export function WorkingAnchor({ isRunning, label }: Props) {
  const [elapsed, setElapsed] = useState(0)

  // The clock resets in the render where `isRunning` flips, not in an effect
  // afterwards. Two things were wrong with the effect version: `useRef(Date.now())`
  // read the clock on every render (React 19 `purity`), and `setElapsed(0)`
  // inside the effect body is a cascading render (`set-state-in-effect`) that
  // lands AFTER paint — so the first quarter second of a new run showed the
  // previous run's time. React's documented "adjust state while rendering"
  // shape re-runs only this component, before anything paints.
  const [wasRunning, setWasRunning] = useState(isRunning)
  if (wasRunning !== isRunning) {
    setWasRunning(isRunning)
    setElapsed(0)
  }

  useEffect(() => {
    if (!isRunning) return
    // The start belongs to this run, so it lives in the run's own closure —
    // no ref, and nothing left over from the previous run to read back.
    const start = Date.now()
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 250)
    return () => clearInterval(interval)
  }, [isRunning])

  if (!isRunning) return null

  return (
    // D-S11: „ein einzelnes Wort in 12,88px mit Shimmer — im Standbild nicht
    // von Fliesstext unterscheidbar."
    //
    // Der Shimmer allein traegt die Aussage nur, solange etwas laeuft UND man
    // hinsieht. Im Standbild — Screenshot, Bildschirmfoto in einem Bugreport,
    // `prefers-reduced-motion`, wo die Kaskade in index.css die Animation nach
    // einem Durchlauf anhaelt — bleibt ein graues Wort in Textgroesse ueber
    // dem Transkript stehen. Es sah aus wie eine angefangene Antwort.
    //
    // Drei Dinge machen daraus einen Status, und alle drei wirken OHNE
    // Bewegung:
    //   1. Ein Behaelter mit Kante und Radius — die Form eines Chips, nicht
    //      die eines Absatzes. `inline-flex` + `w-fit`, damit er genau so
    //      breit ist wie sein Inhalt und nicht als Zeile durchlaeuft.
    //   2. Ein Punkt davor. `lu-band-dot` pulst, wenn Bewegung erlaubt ist,
    //      und ist sonst einfach ein Punkt in der Akzentfarbe — dieselbe
    //      Klasse, die die Werkzeugleiste schon benutzt, kein zweites Rezept.
    //   3. `role="status"` + `aria-live="polite"`. Das Wort war fuer
    //      Screenreader vorher gar nichts; jetzt wird der Beginn eines Laufs
    //      angesagt. Der Sekundenzaehler steht bewusst in `aria-hidden`,
    //      sonst spricht die Ansage im Viertelsekundentakt.
    <div
      className="flex items-center pl-11 pr-3 py-1.5"
      data-testid="working-anchor"
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex w-fit items-center gap-2 rounded-full border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] pl-2 pr-2.5 py-1">
        {/* Akzent hell / dunkel getrennt, gerechnet gegen den Behaelter:
            #a094f8 auf gray-50 (#f9fafb) = 2,49:1 — zu wenig; die im Haus
            schon definierte Hellmodus-Kante #8b7cf0 kommt auf 3,22:1.
            Im Dunkeln steht #a094f8 auf white/[0.03] ueber #1e1e1e (= #252525)
            bei 5,90:1. */}
        <span
          aria-hidden="true"
          className="lu-band-dot w-1.5 h-1.5 rounded-full bg-lu-accent-edge dark:bg-lu-accent shrink-0"
        />
        <span className="lu-tool-shimmer t-control">{label ?? 'Working'}</span>
        {elapsed >= 1 && (
          <span aria-hidden="true" className="lu-hud-num text-[0.6rem] text-gray-500 dark:text-gray-500">
            {formatElapsed(elapsed)}
          </span>
        )}
      </span>
    </div>
  )
}
