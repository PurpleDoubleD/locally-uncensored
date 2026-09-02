/**
 * GH #118, the dead-button half: "the 'Get' button doesn't do anything as the
 * files are still downloaded". Once the badge told the truth again, the state
 * the reporter was left in was an inert "Installed" pill next to an engine that
 * was not running, and the Models page had no way on at all.
 *
 * Run: npx vitest run src/lib/__tests__/model-tile-action.test.ts
 */
import { describe, it, expect } from 'vitest'
import { modelTileAction, tileActionIsClickable, type ModelTileActionInput } from '../model-tile-action'

const base: ModelTileActionInput = {
  externalOnly: false,
  installed: false,
  downloading: false,
  loadable: false,
}

describe('modelTileAction', () => {
  it('offers Get for a model that is not on the disk', () => {
    expect(modelTileAction(base)).toBe('get')
  })

  it('offers Use for an installed model this surface can load', () => {
    // The ticket's state: the file is there, the engine is not running, and the
    // tile now leads somewhere instead of ending in a badge.
    expect(modelTileAction({ ...base, installed: true, loadable: true })).toBe('use')
  })

  // Negative control: without a picker id there is nothing to load, so the tile
  // must not promise an action it cannot perform.
  it('keeps the plain badge when the row cannot be loaded from here', () => {
    expect(modelTileAction({ ...base, installed: true, loadable: false })).toBe('installed')
  })

  it('a download in flight outranks the disk answer', () => {
    expect(modelTileAction({ ...base, installed: true, loadable: true, downloading: true })).toBe(
      'downloading',
    )
  })

  it('an external-only row can only ever be viewed', () => {
    expect(
      modelTileAction({ externalOnly: true, installed: true, downloading: true, loadable: true }),
    ).toBe('view')
  })
})

describe('a tile is never a dead end', () => {
  it('every reachable state either acts or is already doing the work', () => {
    const states: ModelTileActionInput[] = []
    for (const externalOnly of [false, true]) {
      for (const installed of [false, true]) {
        for (const downloading of [false, true]) {
          for (const loadable of [false, true]) {
            states.push({ externalOnly, installed, downloading, loadable })
          }
        }
      }
    }
    for (const s of states) {
      const action = modelTileAction(s)
      if (tileActionIsClickable(action)) continue
      // The two states that legitimately offer no click: a download that is
      // already running, and an installed row nothing here can load.
      expect(action === 'downloading' || (action === 'installed' && !s.loadable)).toBe(true)
    }
  })

  it('the state from the ticket is clickable', () => {
    expect(tileActionIsClickable(modelTileAction({ ...base, installed: true, loadable: true }))).toBe(
      true,
    )
    // Negative control: the pre-2.6.8 shape of that same state was not.
    expect(tileActionIsClickable('installed')).toBe(false)
  })
})
