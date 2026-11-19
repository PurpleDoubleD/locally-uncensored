// The one people rule (19.11.2026): one row per person, number, place,
// character; each model gets its own form; what a model cannot do is said,
// never switched.
import { describe, it, expect } from 'vitest'
import {
  checkPeople, peopleElsewhere, peopleSentence, personPlaceShort, personPlaces, swapCan,
  SWAP_H3_VIDEO_EDIT, SWAP_LOCAL_MODEL,
} from '../people-rule'
import { SWAP_KLING_MODEL, SWAP_MAIN_MODEL, SWAP_MODELS, SWAP_OPENJUTSU_MODEL } from '../../render/swap'
import { swapLocalModels, swapLocalProblem, swapLocalSize } from '../swap-local'
import type { ClassifiedModel } from '../../../api/comfyui'

const L = { mark: { x: 0.2, y: 0.5 } }
const R = { mark: { x: 0.8, y: 0.5 } }
const M = { mark: { x: 0.5, y: 0.5 } }

describe('places', () => {
  it('a tap sets the place, left to right; a missing person comes in later', () => {
    expect(personPlaces([R, L])).toEqual(['the person on the right', 'the person on the left'])
    expect(personPlaces([L, M, R])).toEqual(['the person on the left', 'the person in the middle', 'the person on the right'])
    expect(personPlaces([L, { later: 'right' }])).toEqual(['the person', 'the person who walks in later from the right'])
    expect(personPlaces([{}])).toEqual(['the person'])
    expect(personPlaceShort([R, L], 0)).toBe('right')
    expect(personPlaceShort([L, M, R], 1)).toBe('middle')
    expect(personPlaceShort([L, { later: 'left' }], 1)).toBe('later from the left')
    expect(personPlaceShort([{}], 0)).toBe('main person')
    expect(personPlaceShort([{}, {}], 1)).toBe('')
  })

  it('H3 gets one sentence from the rows (the form of the real test of 18.11.)', () => {
    expect(peopleSentence([L, R])).toBe('The person on the left is <Picture 1>, the person on the right is <Picture 2>.')
    expect(peopleSentence([L, { later: 'right' }])).toBe('The person is <Picture 1>, the person who walks in later from the right is <Picture 2>.')
  })
})

describe('what a model cannot do is said, with a model that can', () => {
  it('too many people: the rows over the limit say it, Create waits, a model that can is recommended', () => {
    const c = checkPeople(SWAP_KLING_MODEL, [L, R], SWAP_MODELS)
    expect(c.rows).toEqual([null, 'Kling 3.0 Pro replaces one person.'])
    expect(c.blocker).toBe('Kling 3.0 Pro replaces one person. Remove a person or pick another model.')
    expect(c.recommend).toEqual({ model: SWAP_MAIN_MODEL, name: 'SCAIL-2', reason: 'takes up to 3 people' })
    expect(checkPeople(SWAP_MAIN_MODEL, [L, M, R, L], SWAP_MODELS).recommend?.model).toBe(SWAP_OPENJUTSU_MODEL)
    expect(checkPeople(SWAP_MAIN_MODEL, [L, M, R], SWAP_MODELS).blocker).toBeNull()
  })

  it('a person who walks in later: SCAIL-2 says it needs everyone in the first frame, H3 can (where it is offered)', () => {
    const rows = [L, { later: 'right' as const }]
    const c = checkPeople(SWAP_MAIN_MODEL, rows, [...SWAP_MODELS, SWAP_H3_VIDEO_EDIT])
    expect(c.rows).toEqual([null, 'SCAIL-2 needs everyone in the first frame.'])
    expect(c.recommend).toEqual({ model: SWAP_H3_VIDEO_EDIT, name: 'MiniMax H3 Video Edit', reason: 'takes a person who walks in later' })
    expect(checkPeople(SWAP_H3_VIDEO_EDIT, rows).blocker).toBeNull()
    // Where no model of the app takes it, Create says what to do instead.
    const desk = checkPeople(SWAP_MAIN_MODEL, rows, SWAP_MODELS)
    expect(desk.recommend).toBeNull()
    expect(peopleElsewhere(rows, false, SWAP_MODELS)).toMatch(/No model in this app takes a person who walks in later/)
  })

  it('the local way takes one person; more say LU Cloud', () => {
    expect(swapCan(SWAP_LOCAL_MODEL)).toMatchObject({ people: 1, form: 'mask', local: true })
    const c = checkPeople(SWAP_LOCAL_MODEL, [L, R], [SWAP_LOCAL_MODEL])
    expect(c.blocker).toMatch(/^Local \(Wan 2\.2 Animate\) replaces one person\./)
    expect(c.recommend).toBeNull()
    expect(peopleElsewhere([L, R], true, [SWAP_LOCAL_MODEL])).toBe('2 people at once run on LU Cloud (SCAIL-2 takes up to 3).')
  })
})

describe('the local swap', () => {
  const m = (name: string, type: ClassifiedModel['type']): ClassifiedModel => ({ name, type, source: 'diffusion_models' } as unknown as ClassifiedModel)

  it('runs on the Animate models only', () => {
    const list = [m('Wan2.2-Animate-14B-Q4_K_M.gguf', 'wananimate'), m('wan2.1_vace_14B.safetensors', 'wanvace')]
    expect(swapLocalModels(list).map((x) => x.name)).toEqual(['Wan2.2-Animate-14B-Q4_K_M.gguf'])
  })

  it('checks video, character, people and consent in the panel order', () => {
    const img = { filename: 'a.png', url: 'data:', width: 1, height: 1 }
    const ok = { videoInput: {}, swapFigures: [{ image: img, role: '' }], swapConsent: true }
    expect(swapLocalProblem({ ...ok, videoInput: null })).toBe('Add the original video first.')
    expect(swapLocalProblem({ ...ok, swapFigures: [{ image: null, role: '' }] })).toMatch(/Pick a character/)
    expect(swapLocalProblem({ ...ok, swapFigures: [{ image: img, role: '' }, { image: img, role: '' }] })).toMatch(/LU Cloud/)
    expect(swapLocalProblem({ ...ok, swapConsent: false })).toMatch(/Confirm/)
    expect(swapLocalProblem(ok)).toBeNull()
  })

  it('a portrait video runs portrait', () => {
    expect(swapLocalSize(832, 480, { width: 720, height: 1280 })).toEqual({ width: 480, height: 832 })
    expect(swapLocalSize(832, 480, { width: 1280, height: 720 })).toEqual({ width: 832, height: 480 })
    expect(swapLocalSize(832, 480, null)).toEqual({ width: 832, height: 480 })
  })
})
