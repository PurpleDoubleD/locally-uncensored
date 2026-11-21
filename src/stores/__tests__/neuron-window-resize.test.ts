import { beforeEach, describe, expect, it } from 'vitest'
import {
  NEURON_WINDOW_GAP as GAP,
  NEURON_WINDOW_MAX_H,
  NEURON_WINDOW_MIN_H as MIN_H,
  NEURON_WINDOW_MIN_W as MIN_W,
  NEURON_WINDOW_W,
  resizeWindowRect,
  resolveWindowRect,
  useNeuronWindow,
  type NeuronWindowEdge,
  type NeuronWindowPos,
  type NeuronWindowSize,
} from '../neuronWindowStore'

const VW = 1400
const VH = 900
const START = { x: 400, y: 100, w: 500, h: 500 }

describe('resolveWindowRect: what is saved, held inside the app window', () => {
  it('without saved values it is the window it always was', () => {
    const r = resolveWindowRect(null, null, VW, VH)
    expect(r).toEqual({ x: VW - NEURON_WINDOW_W - 16, y: 64, w: NEURON_WINDOW_W, h: Math.min(NEURON_WINDOW_MAX_H, VH - 64 - GAP) })
  })

  it('keeps a size and place that fit', () => {
    expect(resolveWindowRect({ x: 100, y: 50 }, { w: 700, h: 600 }, VW, VH)).toEqual({ x: 100, y: 50, w: 700, h: 600 })
  })

  it('limits a saved size to the minimum and to the app window', () => {
    expect(resolveWindowRect({ x: 50, y: 50 }, { w: 10, h: 10 }, VW, VH)).toMatchObject({ w: MIN_W, h: MIN_H })
    expect(resolveWindowRect({ x: 50, y: 50 }, { w: 9000, h: 9000 }, VW, VH)).toEqual({ x: GAP, y: GAP, w: VW - 2 * GAP, h: VH - 2 * GAP })
  })

  it('moves back into view when the app window got smaller, whole window visible', () => {
    const r = resolveWindowRect({ x: 1000, y: 500 }, { w: 600, h: 500 }, 900, 700)
    expect(r.x + r.w).toBeLessThanOrEqual(900 - GAP)
    expect(r.y + r.h).toBeLessThanOrEqual(700 - GAP)
    expect(r).toMatchObject({ w: 600, h: 500 })
  })

  it('an app window below the minimum wins: nothing reaches past it', () => {
    const r = resolveWindowRect({ x: 200, y: 200 }, { w: 500, h: 500 }, 300, 240)
    expect(r).toEqual({ x: GAP, y: GAP, w: 300 - 2 * GAP, h: 240 - 2 * GAP })
  })

  it('reads a damaged store as not saved', () => {
    const junkPos = { x: Number.NaN, y: 'a' } as unknown as NeuronWindowPos
    const junkSize = { w: null, h: Number.POSITIVE_INFINITY } as unknown as NeuronWindowSize
    expect(resolveWindowRect(junkPos, junkSize, VW, VH)).toEqual(resolveWindowRect(null, null, VW, VH))
  })

  it('folded, only the title bar has to stay in view', () => {
    const r = resolveWindowRect({ x: 100, y: 800 }, { w: 500, h: 600 }, VW, VH, true)
    expect(r.y).toBe(800)
    expect(r.h).toBe(600)
  })
})

describe('resizeWindowRect: pulling a side or corner', () => {
  const cases: Array<[NeuronWindowEdge, typeof START]> = [
    ['e', { x: 400, y: 100, w: 540, h: 500 }],
    ['w', { x: 440, y: 100, w: 460, h: 500 }],
    ['s', { x: 400, y: 100, w: 500, h: 530 }],
    ['n', { x: 400, y: 130, w: 500, h: 470 }],
    ['se', { x: 400, y: 100, w: 540, h: 530 }],
    ['nw', { x: 440, y: 130, w: 460, h: 470 }],
    ['ne', { x: 400, y: 130, w: 540, h: 470 }],
    ['sw', { x: 440, y: 100, w: 460, h: 530 }],
  ]
  it.each(cases)('%s moves its own sides and leaves the others', (edge, want) => {
    expect(resizeWindowRect(START, edge, 40, 30, VW, VH)).toEqual(want)
  })

  it('stops at the minimum with the opposite side fixed', () => {
    const r = resizeWindowRect(START, 'nw', 2000, 2000, VW, VH)
    expect(r).toEqual({ x: START.x + START.w - MIN_W, y: START.y + START.h - MIN_H, w: MIN_W, h: MIN_H })
  })

  it('stops at the app window', () => {
    expect(resizeWindowRect(START, 'se', 5000, 5000, VW, VH)).toEqual({ x: 400, y: 100, w: VW - GAP - 400, h: VH - GAP - 100 })
    expect(resizeWindowRect(START, 'nw', -5000, -5000, VW, VH)).toEqual({ x: GAP, y: GAP, w: 900 - GAP, h: 600 - GAP })
  })
})

describe('the store', () => {
  beforeEach(() => useNeuronWindow.setState({ pos: null, size: null }))

  it('saves place and size together', () => {
    useNeuronWindow.getState().setRect({ x: 20, y: 30, w: 640, h: 480 })
    const s = useNeuronWindow.getState()
    expect(s.pos).toEqual({ x: 20, y: 30 })
    expect(s.size).toEqual({ w: 640, h: 480 })
  })

  it('a store from before this version has no size and opens as before', () => {
    expect(useNeuronWindow.getState().size).toBeNull()
    expect(resolveWindowRect({ x: 40, y: 80 }, null, VW, VH).w).toBe(NEURON_WINDOW_W)
  })
})
