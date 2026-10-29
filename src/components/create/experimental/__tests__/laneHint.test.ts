/**
 * Regression: the Motion Control card kept printing "add a character image and
 * a driving dance/pose video above, then hit Create" while both chips were
 * filled and the sampler was already counting steps (2026-07-26, live
 * run on the 2.5.9 ship exe). The caption hung off `!needsPrompt` alone, so it
 * never reacted to the inputs or to a run being in flight.
 *
 * These pin the rule in both directions, including the two cases that must NOT
 * change: the eraser caption is the only place that mentions painting a mask,
 * and a mask is deliberately not part of `specialReady`.
 */
import { describe, it, expect } from 'vitest'
import { noPromptHint, shouldShowLaneHint } from '../laneHint'
import type { CreateIntent } from '../../../../stores/createStore'

const show = (
  intent: CreateIntent,
  o: Partial<{ needPrompt: boolean; isGenerating: boolean; specialReady: boolean }> = {},
) =>
  shouldShowLaneHint({
    needPrompt: false,
    isGenerating: false,
    specialReady: false,
    intent,
    ...o,
  })

describe('shouldShowLaneHint', () => {
  it('shows the motion caption while the inputs are still missing', () => {
    expect(show('motion', { specialReady: false })).toBe(true)
  })

  it('hides the motion caption once both chips are in', () => {
    expect(show('motion', { specialReady: true })).toBe(false)
  })

  it('hides every caption while a run is in flight', () => {
    // The exact case the owner watched: ready inputs plus a running sampler.
    expect(show('motion', { specialReady: true, isGenerating: true })).toBe(false)
    // And the incomplete case too, because mid run it is not an instruction.
    expect(show('motion', { specialReady: false, isGenerating: true })).toBe(false)
    expect(show('eraser', { isGenerating: true })).toBe(false)
  })

  it('applies the same rule to the other two input captions', () => {
    for (const id of ['character', 'lipsync'] as CreateIntent[]) {
      expect(show(id, { specialReady: false })).toBe(true)
      expect(show(id, { specialReady: true })).toBe(false)
    }
  })

  it('keeps the action captions up even when the lane reports ready', () => {
    // These describe the click, not a missing input. The eraser one carries the
    // only "paint a mask" instruction in the UI and specialReady is true for it
    // as soon as an image is loaded, so readiness must not hide it.
    for (const id of ['eraser', 'upscale', 'removebg'] as CreateIntent[]) {
      expect(show(id, { specialReady: true })).toBe(true)
    }
  })

  it('shows nothing at all for lanes that have a prompt field', () => {
    expect(show('image', { needPrompt: true })).toBe(false)
    expect(show('motion', { needPrompt: true, specialReady: false })).toBe(false)
  })
})

describe('noPromptHint', () => {
  it('names the inputs each lane is waiting for', () => {
    expect(noPromptHint('motion')).toContain('driving dance/pose video')
    expect(noPromptHint('lipsync')).toContain('voice')
    // GH #121: the local trainer takes 100, the cloud job API 30.
    expect(noPromptHint('character', 'local')).toContain('4 to 100 photos')
    expect(noPromptHint('character', 'cloud')).toContain('4 to 30 photos')
  })

  it('speaks of a style, not of one person, in the style mode (FEHLER-P8 #1)', () => {
    const style = noPromptHint('character', 'local', false, 'style')
    expect(style).toBe('Add 4 to 100 pictures that share the style above, give it a name, then hit Create to train.')
    expect(style).not.toMatch(/person|trigger|photos/)
    expect(noPromptHint('character', 'local', true, 'style')).toBe(style)
    // The cloud has no style mode: a leftover choice changes nothing there.
    expect(noPromptHint('character', 'cloud', false, 'style')).toBe(noPromptHint('character', 'cloud'))
    expect(noPromptHint('character', 'local', false, 'character')).toContain('photos of one person or character')
  })

  it('keeps the eraser on its own line instead of the cutout default', () => {
    // The old copy said "remove the background" for every prompt-less lane,
    // which walked eraser users straight into "Paint a mask first".
    expect(noPromptHint('eraser')).toContain('Paint a mask')
    expect(noPromptHint('eraser')).not.toContain('remove the background')
    expect(noPromptHint('upscale')).toContain('enhance the image')
    expect(noPromptHint('removebg')).toContain('remove the background')
  })
})
