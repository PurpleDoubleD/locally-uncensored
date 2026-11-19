/**
 * A33 (Discord, 17.11.2026): since 3.1.0 a right click on a misspelled word
 * in the prompt field showed no spelling suggestions. LU's own menu now asks
 * the system checker about the word under the click.
 *
 * Run: npx vitest run src/lib/__tests__/a33-spelling-in-the-text-menu.test.ts
 */
import { describe, expect, it } from 'vitest'
import { wordAt } from '../text-context-menu'

describe('the word a right click is about', () => {
  const text = 'a portrait, recieve the light; state-of-the-art'
  it('is the word around the caret', () => {
    const at = text.indexOf('recieve') + 3
    expect(wordAt(text, at, at)).toEqual({ word: 'recieve', from: 12, to: 19 })
  })
  it('is found from either edge of the word', () => {
    expect(wordAt(text, 12, 12)?.word).toBe('recieve')
    expect(wordAt(text, 19, 19)?.word).toBe('recieve')
  })
  it('is the selection when that is one word, without its punctuation edge', () => {
    expect(wordAt(text, 12, 19)?.word).toBe('recieve')
    expect(wordAt("it's", 0, 4)?.word).toBe("it's")
    expect(wordAt(text, text.indexOf('state'), text.length)?.word).toBe('state-of-the-art')
  })
  it('is nothing for a selection of several words or a click on blank space', () => {
    expect(wordAt(text, 0, 11)).toBeNull()
    expect(wordAt('a  b', 2, 2)).toBeNull()
    expect(wordAt('', 0, 0)).toBeNull()
  })
  it('takes letters of any language', () => {
    expect(wordAt('ein Übermaß an', 6, 6)?.word).toBe('Übermaß')
  })
})
