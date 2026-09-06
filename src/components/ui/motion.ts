import type { Transition } from 'framer-motion'

/**
 * Motion-Leiter — die JS-Seite der vier `--motion-*` Tokens aus index.css.
 *
 * framer-motion liest keine CSS-Variablen, deshalb existiert die Leiter zweimal:
 * einmal als CSS-Token (für `transition-*`/Tailwind) und einmal hier (für
 * `motion.*`-Transitions). Die Zahlen sind NICHT neu erfunden, sondern die im
 * Code tatsächlich gemessenen Werte, verdichtet auf drei Stufen:
 *
 *   0.12s ×12 Vorkommen → fast   (Mikro-Feedback: Hover, Toggle, Badge)
 *   0.15s ×21 Vorkommen → base   (Haus-Standard: Ein-/Ausblenden, Listen)
 *   0.20s ×7  Vorkommen →   „   (auf base gerundet)
 *   0.30s ×5  Vorkommen → slow   (Flächen: Dialog, Panel, Slide-over)
 *
 * Wer eine neue Animation baut, nimmt eine dieser Stufen statt einer vierten Zahl.
 */
export const MOTION_MS = {
  /** --motion-fast: Mikro-Feedback, darf nicht „animiert" wirken. */
  fast: 120,
  /** --motion-base: Haus-Standard für Ein-/Ausblendungen. */
  base: 150,
  /** --motion-slow: große Flächen (Dialog, Slide-over). */
  slow: 300,
} as const

/** Sekunden statt Millisekunden — framer-motion rechnet in Sekunden. */
export const MOTION_S = {
  fast: MOTION_MS.fast / 1000,
  base: MOTION_MS.base / 1000,
  slow: MOTION_MS.slow / 1000,
} as const

/**
 * Panel-Feder — Dialogflächen (Modal). Werte unverändert aus Modal.tsx
 * übernommen (damping 25 / stiffness 300 ≈ 300 ms Einschwingen, also
 * --motion-slow); benannt, damit die nächste Fläche nicht wieder rät.
 */
export const SPRING_PANEL = { type: 'spring', damping: 25, stiffness: 300 } as const satisfies Transition

/**
 * Control-Feder — kleine Bedienelemente (ToggleSwitch-Knopf). Werte unverändert
 * aus ToggleSwitch.tsx (stiffness 500 / damping 30 ≈ 150 ms, also --motion-base).
 */
export const SPRING_CONTROL = { type: 'spring', stiffness: 500, damping: 30 } as const satisfies Transition
