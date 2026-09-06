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
// As the server declares it: the off values ride along in the upstream's own
// list, and they are not rungs.
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

describe("the model's own default is the fallback, and only downward", () => {
  // The global setting is the user's wish. The model's declared default is
  // consulted where the wish is off the ladder, because at that point the
  // model knows better than our arithmetic does.
  it('a wish off the ladder lands on the model default', () => {
    expect(clampEffort(['low', 'medium', 'max'], 'high', 'low')).toBe('low')
  })

  it('THE GUARD: a default above the wish is ignored, it would upgrade the bill', () => {
    // Ladder without 'low', user asked for 'low', model says 'max'. Honouring
    // the default here would charge a user who asked for the cheapest rung the
    // most expensive one, silently.
    expect(clampEffort(['medium', 'high', 'max'], 'low', 'max')).toBe('medium')
    expect(clampEffort(['medium', 'high', 'max'], 'low', 'max')).not.toBe('max')
  })

  it('a default that is not on the ladder is no help and is skipped', () => {
    expect(clampEffort(['low', 'medium'], 'max', 'high')).toBe('medium')
    expect(clampEffort(['low', 'medium'], 'max', 'nonsense')).toBe('medium')
  })

  it('a wish ON the ladder is never overruled by the default', () => {
    expect(clampEffort(['low', 'medium', 'high'], 'low', 'high')).toBe('low')
  })

  it('and an unknown wish takes the default before it takes ours', () => {
    expect(clampEffort(['low', 'medium', 'high'], 'ludicrous', 'low')).toBe('low')
    expect(clampEffort(['low', 'medium', 'high'], 'ludicrous')).toBe('high')
  })

  it('no fallback at all behaves exactly as before', () => {
    expect(clampEffort(MOST, 'max')).toBe('high')
    expect(clampEffort(['medium', 'high'], 'low')).toBe('medium')
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

describe("'none' and 'minimal' are off values and never rungs", () => {
  it('a server that sends them among the levels does not get them offered', () => {
    expect(effortChoices(['none', 'low', 'high'])).toEqual(['low', 'high'])
    expect(effortChoices(QWEN38_27B)).toEqual(['low', 'medium'])
    expect(effortChoices(['none', 'minimal'])).toEqual([])
    expect(hasEffortLadder(['none', 'minimal'])).toBe(false)
  })

  it('THE RULE: clamping never answers with an off value, whatever the ladder says', () => {
    // A ladder of ['minimal','low','medium'] with a wish of 'max' has exactly
    // one honest answer, and 'minimal' is not it: it would read as a rung in
    // the composer while meaning "stop thinking" on the wire.
    expect(clampEffort(QWEN38_27B, 'max')).toBe('medium')
    expect(clampEffort(QWEN38_27B, 'low')).toBe('low')
    // An off value as the WISH is not a rung either, so it falls through the
    // unknown-wish path rather than being honoured as "think barely".
    expect(clampEffort(QWEN38_27B, 'minimal')).toBe('medium')
    expect(clampEffort(['minimal', 'medium'], 'low')).toBe('medium')
    expect(clampEffort(['none', 'low'], 'max')).toBe('low')
  })

  it('and a ladder of nothing but off values is no ladder at all', () => {
    expect(clampEffort(['none', 'minimal'], 'low')).toBe(DEFAULT_EFFORT)
    expect(nextEffort(['minimal'], 'low')).toBe(DEFAULT_EFFORT)
  })

  it('nothing on this ladder ever answers none, on any wish', () => {
    for (const wish of ['none', 'minimal', 'low', 'medium', 'high', 'max', 'ludicrous']) {
      for (const ladder of [GLM53, MOST, QWEN38_27B, ['none', 'minimal', 'high']]) {
        expect(['none', 'minimal']).not.toContain(clampEffort(ladder, wish))
        expect(['none', 'minimal']).not.toContain(nextEffort(ladder, wish))
      }
    }
  })

  it('the four rungs are the whole ladder', () => {
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
    expect(isEffortLevel('minimal')).toBe(false)
    expect(isEffortLevel('xhigh')).toBe(false)
  })
})
