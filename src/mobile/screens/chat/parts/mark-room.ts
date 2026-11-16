/**
 * Does the mark of an empty chat fit into the free area.
 *
 * In little room (ui/room.ts: a phone on its side, very large text) the
 * greeting of an empty chat used to drop its mark by rule. The rule counted
 * lines of text on the whole screen, not the room the greeting has: with the
 * largest text on a tall phone the new chat stood without its mark although
 * 195 points were free above and below it (short check on the iPhone,
 * package 8, B1). The mark is decoration and gives way where a heading barely
 * fits, so the question is the room, and the room is measured: the height of
 * the scrolling area against the height of the greeting with its mark.
 *
 * The answer is `data-m-mark-fits` on the box of the chat. The stylesheet
 * hides the mark in little room only where that attribute is missing.
 *
 * The same for the words of the greeting (check of package 17 on Android,
 * A1): on its side at 511x272 with the text zoom 2.0 and a notice above,
 * "Ask LU anything" stood half under the composer. A greeting without
 * buttons now shows only what fits whole: `data-m-greeting="title"` keeps the
 * heading and hides the line under it, `"none"` hides the greeting. Hidden
 * keeps its place (visibility), so the measure does not change with it.
 *
 * The mark is not part of that measure: where the greeting does not fit, it
 * goes (display, also outside little room). Check of package 18 on Android,
 * A1 rest: at 320x487 upright with the text zoom 1.0 and a notice above, the
 * mark only went invisible, kept its place and pushed the heading under the
 * composer.
 */
import { useLayoutEffect, type RefObject } from 'react'

/** The mark of an EmptyState (ui/EmptyState.tsx). */
export const MARK_PX = 56

/**
 * Pure. `greetingHeight` is the height of the greeting as it is drawn now,
 * `markShown` whether the mark is part of that height. With or without the
 * mark on screen the answer is the same, so the mark never flickers.
 */
export function markFits(greetingHeight: number, markShown: boolean, gapPx: number, roomHeight: number, markPx: number = MARK_PX): boolean {
  if (!(roomHeight > 0) || !(greetingHeight > 0)) return false
  const withMark = markShown ? greetingHeight : greetingHeight + markPx + Math.max(0, gapPx)
  return withMark <= roomHeight
}

/** What of a greeting without buttons fits whole into the room: all of it, only the heading, or nothing. */
export type GreetingRoom = 'all' | 'title' | 'none'

/**
 * Pure. `contentHeight` is the greeting without its mark, `titleBottom` the
 * lower edge of the heading measured from the top of that content, `room`
 * the height the greeting has. A half pixel of rounding is allowed.
 */
export function greetingRoom(contentHeight: number, titleBottom: number, room: number): GreetingRoom {
  if (!(room > 0) || !(contentHeight > 0)) return 'all'
  if (contentHeight <= room + 0.5) return 'all'
  if (titleBottom > 0 && titleBottom <= room + 0.5) return 'title'
  return 'none'
}

/** Keep `data-m-mark-fits` and `data-m-greeting` on `box` (the element that holds the greeting) true to the room, while `active`. */
export function useMarkRoom(box: RefObject<HTMLElement | null>, active: boolean): void {
  // Before the first paint: the mark does not come a frame late.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (!active) {
      el.removeAttribute('data-m-mark-fits')
      el.removeAttribute('data-m-greeting')
      return
    }
    let frame = 0
    // In the same frame, before it is painted: a notice that takes room from the greeting must not show the
    // greeting over the composer for a frame first.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null
    const measure = () => {
      frame = 0
      const greeting = el.querySelector<HTMLElement>(':scope > .m-empty')
      const room = el.closest<HTMLElement>('.m-body')
      if (!greeting || !room) {
        el.removeAttribute('data-m-greeting')
        return el.removeAttribute('data-m-mark-fits')
      }
      // The greeting is another element when the page changes what it says (no model, a model on its way).
      observer?.observe(greeting)
      observer?.observe(room)
      const mark = greeting.querySelector<HTMLElement>(':scope > .m-empty-mark')
      const gap = parseFloat(getComputedStyle(greeting).rowGap) || 0
      const padY = (node: HTMLElement) => {
        const style = getComputedStyle(node)
        return (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
      }
      const space = room.clientHeight - padY(room) - padY(el)
      const markShown = !!mark && mark.offsetHeight > 0
      const fits = markFits(greeting.offsetHeight, markShown, gap, space)
      if (fits) el.setAttribute('data-m-mark-fits', '')
      else el.removeAttribute('data-m-mark-fits')
      // The words: only for a greeting without buttons (a button must stay reachable, its page scrolls to it).
      const title = greeting.querySelector<HTMLElement>(':scope > .m-empty-title')
      if (fits || !title || greeting.querySelector(':scope > .m-empty-actions')) {
        el.removeAttribute('data-m-greeting')
      } else {
        const markPart = markShown && mark ? mark.offsetHeight + gap : 0
        const top = greeting.getBoundingClientRect().top + markPart
        const state = greetingRoom(greeting.offsetHeight - markPart, title.getBoundingClientRect().bottom - top, space)
        // The words fit and the mark does not: the mark still has to go. Outside little room only data-m-greeting takes
        // it away (styles/components.css), so "all words" is said as "words" and not as no attribute. Seen in the
        // 3.1.0 e2e (320x568 upright, a notice above, the taller composer of prompt v2): the mark stayed and pushed
        // "Type below to start." under the composer.
        el.setAttribute('data-m-greeting', state === 'all' ? 'words' : state)
      }
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const swaps = typeof MutationObserver === 'function' ? new MutationObserver(queue) : null
    swaps?.observe(el, { childList: true })
    window.addEventListener('resize', queue)
    window.addEventListener('lu:font-scale', queue)
    // The mark of little room comes and goes with the keyboard and the text size (ui/room.ts).
    const mutations = typeof MutationObserver === 'function' ? new MutationObserver(queue) : null
    mutations?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-m-room', 'class'] })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      mutations?.disconnect()
      swaps?.disconnect()
      window.removeEventListener('resize', queue)
      window.removeEventListener('lu:font-scale', queue)
    }
  }, [box, active])
}
