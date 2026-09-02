/**
 * The effort ladder, the arithmetic of it.
 *
 * Three things have to hold, and each one has a live measurement behind it
 * (ops/wissen/deepinfra-modellmatrix-2026-09-02.md, 52 models against the real
 * API on 2026-09-02):
 *
 *  1. CLAMPING. Qwen/Qwen3.8-27B answers 400 to 'high' AND 'max' and names
 *     'low' and 'medium' as its rungs. A composer that sends one fixed scale to
 *     every model breaks every request on that one model.
 *  2. NO LADDER, NO CHANGE. A server that predates the field sends nothing, and
 *     nothing has to mean the 'high' this client has always sent. Otherwise an
 *     update moves an existing customer's token bill without them touching a
 *     thing.
 *  3. 'none' IS NOT A RUNG. On GLM 5.3 'none' does not stop the thinking, it
 *     only stops the upstream from separating it: the monologue lands in the
 *     customer's chat window and burns MORE tokens than sending no parameter at
 *     all (53/125/130 tokens clean against 102/113/135 with none, and no answer
 *     inside the budget). A model that always reasons must therefore never be
 *     offered 'none' by anything here.
 *
 * Run: npx vitest run src/lib/__tests__/effort.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  clampEffort,
  effortChoices,
  effortLabel,
  hasEffortLadder,
  nextEffort,
  isEffortLevel,
  DEFAULT_EFFORT,
  EFFORT_STEPS,
} from '../effort'

const GLM53 = ['low', 'medium', 'high', 'max']
const MOST = ['low', 'medium', 'high']
const QWEN38_27B = ['minimal', 'low', 'medium']

describe('clamping the wish onto the rungs a model really has', () => {
  it('leaves a wish the model knows exactly as it is', () => {
    expect(clampEffort(GLM53, 'medium')).toBe('medium')
    expect(clampEffort(GLM53, 'max')).toBe('max')
  })

  it('THE MEASUREMENT: max on a model without max becomes its top rung, not a 400', () => {
    expect(clampEffort(MOST, 'max')).toBe('high')
    expect(clampEffort(QWEN38_27B, 'max')).toBe('medium')
    expect(clampEffort(QWEN38_27B, 'high')).toBe('medium')
  })

  it('rounds UP only when there is nothing at or below the wish', () => {
    expect(clampEffort(['medium', 'high'], 'low')).toBe('medium')
  })

  it('takes the rungs in any order the server happens to send them', () => {
    expect(clampEffort(['max', 'low', 'high'], 'medium')).toBe('low')
  })

  it('drops words it does not know instead of forwarding them', () => {
    // 'xhigh' shows up in one upstream error message and in no documentation.
    // Forwarding a word we cannot rank is how an invalid value reaches a model
    // that reads invalid as "think as hard as you can".
    expect(clampEffort(['low', 'xhigh'], 'high')).toBe('low')
    expect(clampEffort(['xhigh', 'ludicrous'], 'high')).toBe(DEFAULT_EFFORT)
  })

  it('treats a wish it does not know as the default wish, never as the top rung', () => {
    expect(clampEffort(GLM53, 'ludicrous')).toBe('high')
    expect(clampEffort(GLM53, 'ludicrous')).not.toBe('max')
  })
})

describe('no ladder means no change', () => {
  it('an absent ladder answers with the rung this client has always sent', () => {
    expect(clampEffort(undefined, 'low')).toBe('high')
    expect(clampEffort([], 'max')).toBe('high')
    expect(DEFAULT_EFFORT).toBe('high')
  })

  it('and offers no rungs to the composer, so no control is drawn', () => {
    expect(effortChoices(undefined)).toEqual([])
    expect(effortChoices([])).toEqual([])
    expect(hasEffortLadder(undefined)).toBe(false)
    expect(hasEffortLadder(['nonsense'])).toBe(false)
    expect(hasEffortLadder(MOST)).toBe(true)
  })
})

describe("'none' is the off switch and never a rung", () => {
  it('a server that sends none among the levels does not get it offered', () => {
    expect(effortChoices(['none', 'low', 'high'])).toEqual(['low', 'high'])
    expect(clampEffort(['none', 'low'], 'max')).toBe('low')
  })

  it('nothing on this ladder ever answers none, on any wish', () => {
    for (const wish of ['none', 'minimal', 'low', 'medium', 'high', 'max', 'ludicrous']) {
      expect(clampEffort(GLM53, wish)).not.toBe('none')
      expect(nextEffort(GLM53, wish)).not.toBe('none')
    }
  })

  it('and minimal is not offered either, the Think button already says off', () => {
    expect(effortChoices(QWEN38_27B)).toEqual(['low', 'medium'])
    expect(EFFORT_STEPS).toEqual(['low', 'medium', 'high', 'max'])
  })
})

describe('the cycling button', () => {
  it('walks the rungs the model has and wraps at the top', () => {
    expect(nextEffort(GLM53, 'low')).toBe('medium')
    expect(nextEffort(GLM53, 'high')).toBe('max')
    expect(nextEffort(GLM53, 'max')).toBe('low')
  })

  it('wraps on a short ladder without ever leaving it', () => {
    expect(nextEffort(QWEN38_27B, 'medium')).toBe('low')
    expect(nextEffort(MOST, 'high')).toBe('low')
  })

  it('starts from the clamped rung, so the display and the next click agree', () => {
    // The user's global wish is 'max', this model tops out at 'high': the
    // button shows High and one click has to give Low, not Low-via-Max.
    expect(nextEffort(MOST, 'max')).toBe('low')
  })
})

describe('labels and the type guard', () => {
  it('says the rung in one short word', () => {
    expect(effortLabel('low')).toBe('Low')
    expect(effortLabel('medium')).toBe('Medium')
    expect(effortLabel('high')).toBe('High')
    expect(effortLabel('max')).toBe('Max')
  })

  it('knows a real rung from a stored typo', () => {
    expect(isEffortLevel('high')).toBe(true)
    expect(isEffortLevel('none')).toBe(false)
    expect(isEffortLevel('xhigh')).toBe(false)
  })
})
