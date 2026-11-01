/**
 * D3 (3.0.9, Discord 01.11.2026): several gallery items at once. The rules
 * of the selection (Cmd/Ctrl-click, Shift range, all, none) and the menu that
 * acts on it, as pure functions.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/gallery-selection.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_SELECTION,
  buildGalleryMenu,
  clickSelection,
  deleteConfirmLine,
  menuSelection,
  selectAll,
} from '../gallerySelection'

const ORDER = ['a', 'b', 'c', 'd', 'e']

describe('clicking tiles', () => {
  it('a plain click selects nothing: it opens the item, as before, and sets the anchor', () => {
    const s = clickSelection(EMPTY_SELECTION, ORDER, 'b', { toggle: false, range: false })
    expect(s).toEqual({ ids: [], anchor: 'b' })
  })

  it('Cmd/Ctrl-click adds and removes one item', () => {
    let s = clickSelection(EMPTY_SELECTION, ORDER, 'b', { toggle: true, range: false })
    s = clickSelection(s, ORDER, 'd', { toggle: true, range: false })
    expect(s.ids).toEqual(['b', 'd'])
    s = clickSelection(s, ORDER, 'b', { toggle: true, range: false })
    expect(s.ids).toEqual(['d'])
  })

  it('Shift-click selects the range from the anchor, in gallery order, both ways', () => {
    const anchored = clickSelection(EMPTY_SELECTION, ORDER, 'b', { toggle: false, range: false })
    expect(clickSelection(anchored, ORDER, 'd', { toggle: false, range: true }).ids).toEqual(['b', 'c', 'd'])
    const fromD = clickSelection(EMPTY_SELECTION, ORDER, 'd', { toggle: true, range: false })
    expect(clickSelection(fromD, ORDER, 'a', { toggle: false, range: true }).ids).toEqual(['a', 'b', 'c', 'd'])
  })

  it('Shift without an anchor selects just that item', () => {
    expect(clickSelection(EMPTY_SELECTION, ORDER, 'c', { toggle: false, range: true }).ids).toEqual(['c'])
  })

  it('a plain click while a selection stands clears it', () => {
    const s = clickSelection({ ids: ['a', 'b'], anchor: 'a' }, ORDER, 'e', { toggle: false, range: false })
    expect(s.ids).toEqual([])
  })

  it('all selects every shown item; ids no longer shown fall out', () => {
    expect(selectAll(ORDER).ids).toEqual(ORDER)
  })
})

describe('the right-click', () => {
  it('on a selected item acts on the whole selection', () => {
    expect(menuSelection({ ids: ['a', 'c'], anchor: 'a' }, 'c').ids).toEqual(['a', 'c'])
  })
  it('on another item acts on that item alone', () => {
    expect(menuSelection({ ids: ['a', 'c'], anchor: 'a' }, 'b')).toEqual({ ids: ['b'], anchor: 'b' })
  })
})

describe('the menu', () => {
  const h = { move: vi.fn(), download: vi.fn(), remove: vi.fn() }

  it('offers exactly the single-item actions, run by the caller', () => {
    const one = buildGalleryMenu(h, 1)
    expect(one.map((m) => m.label)).toEqual(['Move to folder…', 'Download', 'Delete…'])
    expect(one[0].run).toBe(h.move)
    expect(one[1].run).toBe(h.download)
    expect(one[2].run).toBe(h.remove)
    expect(one[2].destructive).toBe(true)
  })

  it('names the count for several', () => {
    expect(buildGalleryMenu(h, 3).map((m) => m.label)).toEqual(['Move 3 to folder…', 'Download 3', 'Delete 3…'])
  })
})

describe('the delete question', () => {
  it('names the count and where the files go, per host', () => {
    expect(deleteConfirmLine(1, false)).toBe('Delete 1 item? Its file moves to the Recycle Bin.')
    expect(deleteConfirmLine(4, true)).toBe('Delete 4 items? Their files move to the Trash.')
  })
})
