/**
 * Which arrangement of a page fits the screen.
 *
 * tall  the normal phone: the content scrolls, a footer or composer is fixed below it.
 * wide  a phone on its side: two columns side by side.
 * low   too little height for a fixed footer (very large text, or a small
 *       phone on its side): everything is one scrolling column, the input
 *       first, so the main button is never pushed off the screen and never
 *       sits on top of the tab bar.
 *
 * Height and width are counted in units of the text size, because a footer
 * grows with the text and not with the pixels. The unit is the size text is
 * drawn at (ui/text-zoom.ts): on Android the root stays at 16 px while the
 * WebView doubles every letter.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { onTextZoomChange, textUnitPx } from './text-zoom'

export type ScreenShape = 'tall' | 'wide' | 'low'

/** Below this many text units of height a fixed footer no longer fits next to usable content. */
export const TALL_MIN_UNITS = 30
/** A side by side arrangement needs at least this many text units of width. */
export const WIDE_MIN_UNITS = 40

/** Pure. */
export function screenShape(width: number, height: number, rootPx: number): ScreenShape {
  const unit = rootPx > 0 ? rootPx : 16
  if (height / unit >= TALL_MIN_UNITS) return 'tall'
  if (width > height && width / unit >= WIDE_MIN_UNITS) return 'wide'
  return 'low'
}

export interface ShapeSample {
  width: number
  height: number
  unitPx: number
  /** A text field has the focus, so a keyboard may have taken part of the height. */
  editing: boolean
}

export interface ShapeState {
  shape: ScreenShape
  width: number
  unitPx: number
}

/**
 * Pure: the next arrangement from the last one and a new measurement. While a
 * field is being edited and neither the width nor the text size changed, only
 * the keyboard moved: the arrangement stays. A page that puts its input
 * somewhere else in another arrangement (Create: in the fixed footer when
 * tall, at the top of the column when low) would otherwise build the field
 * anew the moment the keyboard opens. The new field has no focus, Android
 * closes the keyboard, the window grows back, the old arrangement returns,
 * and so on: the keyboard kept closing on Create (customer mail of 30.10.,
 * package M1).
 */
export function nextShapeState(prev: ShapeState | null, sample: ShapeSample): ShapeState {
  if (prev && sample.editing && sample.width === prev.width && sample.unitPx === prev.unitPx) return prev
  return { shape: screenShape(sample.width, sample.height, sample.unitPx), width: sample.width, unitPx: sample.unitPx }
}

/** The arrangement of a page, held while the keyboard moves. `height` reads the height the page goes by. */
export function useHeldScreenShape(height: () => number): ScreenShape {
  const sample = (editing: boolean): ShapeSample => ({ width: window.innerWidth, height: height(), unitPx: textUnitPx(), editing })
  const [state, setState] = useState<ShapeState>(() =>
    typeof window === 'undefined' ? { shape: 'tall', width: 0, unitPx: 16 } : nextShapeState(null, sample(false)),
  )
  useEffect(() => {
    const update = () => setState((prev) => nextShapeState(prev, sample(editingNow())))
    update()
    const viewport = window.visualViewport
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.addEventListener('lu:font-scale', update)
    viewport?.addEventListener('resize', update)
    const offZoom = onTextZoomChange(update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.removeEventListener('lu:font-scale', update)
      viewport?.removeEventListener('resize', update)
      offZoom()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read at every event, the reader of the page stays the same
  }, [])
  return state.shape
}

/** The arrangement that fits the screen right now. Follows rotation and the text size; the keyboard only once the field lets go. */
export function useScreenShape(): ScreenShape {
  // The visible height: with the keyboard open the window is as high as before on iOS.
  return useHeldScreenShape(() => window.visualViewport?.height ?? window.innerHeight)
}

// ---------- where the footer of a page goes ----------
//
// A page keeps its main button in a footer under the scrolling content. On a
// phone on its side that footer took most of the page: at 200 percent text
// one or two lines of content were left above it (acceptance android-knoepfe,
// finding M8). Where the page is that low, the footer goes to the end of the
// scrolling content instead. Nothing is hidden and nothing overlaps; the
// button is reached by scrolling, like the rest of the page.

/** On its side, a page lower than this many text units puts its footer into the scrolling content. */
export const FOOT_FIXED_MIN_UNITS_LAND = 24
/** Upright the footer stays fixed down to this height; its own limit of 46 percent does the rest. */
export const FOOT_FIXED_MIN_UNITS_PORT = 16

/** Pure: does the footer scroll with the content on a screen of this size. `unitPx` is the size text is drawn at. */
export function footScrolls(width: number, height: number, unitPx: number): boolean {
  const unit = unitPx > 0 ? unitPx : 16
  const min = width > height ? FOOT_FIXED_MIN_UNITS_LAND : FOOT_FIXED_MIN_UNITS_PORT
  return height / unit < min
}

export interface FootSample {
  width: number
  height: number
  unitPx: number
  /** A text field has the focus, so a keyboard may have taken part of the height. */
  editing: boolean
}

export interface FootState {
  scrolls: boolean
  width: number
  unitPx: number
}

/**
 * Pure: the next answer from the last one and a new measurement. While a
 * field is being edited and neither the width nor the text size changed,
 * only the keyboard moved: the answer stays. Otherwise the footer would jump
 * into the content the moment the keyboard opens, and its buttons would be
 * built anew under the finger.
 */
export function nextFootState(prev: FootState | null, sample: FootSample): FootState {
  if (prev && sample.editing && sample.width === prev.width && sample.unitPx === prev.unitPx) return prev
  return { scrolls: footScrolls(sample.width, sample.height, sample.unitPx), width: sample.width, unitPx: sample.unitPx }
}

export function editingNow(): boolean {
  const el = typeof document === 'undefined' ? null : document.activeElement
  if (!el) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color'].includes((el.getAttribute('type') || 'text').toLowerCase())
  return (el as HTMLElement).isContentEditable === true
}

let foot: FootState | null = null
let footInstalled = false
const footListeners = new Set<() => void>()

function measureFoot(): void {
  const next = nextFootState(foot, { width: window.innerWidth, height: window.innerHeight, unitPx: textUnitPx(), editing: editingNow() })
  const changed = !foot || foot.scrolls !== next.scrolls
  foot = next
  if (changed) for (const fn of [...footListeners]) fn()
}

function subscribeFoot(fn: () => void): () => void {
  footListeners.add(fn)
  if (!footInstalled && typeof window !== 'undefined') {
    footInstalled = true
    measureFoot()
    window.addEventListener('resize', measureFoot)
    window.addEventListener('orientationchange', measureFoot)
    window.addEventListener('lu:font-scale', measureFoot)
    onTextZoomChange(measureFoot)
  }
  return () => {
    footListeners.delete(fn)
  }
}

function footNow(): boolean {
  if (typeof window === 'undefined') return false
  if (!foot) foot = nextFootState(null, { width: window.innerWidth, height: window.innerHeight, unitPx: textUnitPx(), editing: false })
  return foot.scrolls
}

/** True where the footer of a page or a sheet belongs at the end of its scrolling content. */
export function useFootScrolls(): boolean {
  return useSyncExternalStore(subscribeFoot, footNow, () => false)
}

/** Only for tests. */
export function __resetFootForTests(): void {
  foot = null
}
