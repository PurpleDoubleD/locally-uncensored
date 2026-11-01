// Several gallery items at once (D3, 3.0.9, Discord 01.11.2026): the rules of
// the selection and the menu that acts on it, as pure functions. The menu
// offers only what a single tile already does and runs the caller's
// functions (components/ui/menu-actions.ts has the rule); CreatePanel hands in
// the same code its tile buttons use.

import type { MenuAction } from '../../ui/menu-actions'

export interface GallerySelection {
  /** Selected ids, in gallery order. */
  readonly ids: readonly string[]
  /** The last clicked item, where a Shift range starts. */
  readonly anchor: string | null
}

export const EMPTY_SELECTION: GallerySelection = { ids: [], anchor: null }

export interface ClickMods {
  /** Cmd on a Mac, Ctrl elsewhere. */
  readonly toggle: boolean
  readonly range: boolean
}

const inOrder = (order: readonly string[], ids: ReadonlySet<string>) => order.filter((id) => ids.has(id))

/**
 * The selection after a click on `id`. A plain click selects nothing (it opens
 * the item, as it always did) and only moves the anchor.
 */
export function clickSelection(
  prev: GallerySelection,
  order: readonly string[],
  id: string,
  mods: ClickMods,
): GallerySelection {
  if (mods.range) {
    const from = prev.anchor ? order.indexOf(prev.anchor) : -1
    const to = order.indexOf(id)
    if (from < 0 || to < 0) return { ids: [id], anchor: id }
    const [lo, hi] = from < to ? [from, to] : [to, from]
    return { ids: order.slice(lo, hi + 1), anchor: prev.anchor }
  }
  if (mods.toggle) {
    const next = new Set(prev.ids)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { ids: inOrder(order, next), anchor: id }
  }
  return { ids: [], anchor: id }
}

export function selectAll(order: readonly string[]): GallerySelection {
  return { ids: [...order], anchor: order[0] ?? null }
}

/** A right-click on a selected item acts on the selection, on any other on that item alone. */
export function menuSelection(prev: GallerySelection, id: string): GallerySelection {
  return prev.ids.includes(id) ? prev : { ids: [id], anchor: id }
}

/** Ids that are no longer shown (another folder, deleted) drop out. */
export function keepShown(prev: GallerySelection, order: readonly string[]): GallerySelection {
  const shown = new Set(order)
  const ids = prev.ids.filter((id) => shown.has(id))
  const anchor = prev.anchor && shown.has(prev.anchor) ? prev.anchor : null
  return ids.length === prev.ids.length && anchor === prev.anchor ? prev : { ids, anchor }
}

export interface GalleryMenuHandlers {
  readonly move: () => void
  readonly download: () => void
  /** Opens the question; nothing is deleted before it is answered. */
  readonly remove: () => void
}

export function buildGalleryMenu(h: GalleryMenuHandlers, count: number): MenuAction[] {
  const n = count > 1 ? ` ${count}` : ''
  return [
    { id: 'move', label: count > 1 ? `Move${n} to folder…` : 'Move to folder…', run: h.move },
    { id: 'download', label: `Download${n}`, run: h.download },
    { id: 'delete', label: `Delete${n}…`, run: h.remove, destructive: true },
  ]
}

/** The question before deleting. Where the files go, as deleteTitle says it per host. */
export function deleteConfirmLine(count: number, mac: boolean): string {
  const bin = mac ? 'the Trash' : 'the Recycle Bin'
  return count === 1
    ? `Delete 1 item? Its file moves to ${bin}.`
    : `Delete ${count} items? Their files move to ${bin}.`
}
