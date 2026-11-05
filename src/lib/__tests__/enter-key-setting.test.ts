/**
 * GH #202: a setting for the Enter key. "Sends" keeps what Enter always did;
 * "New line" makes Enter a line break and Ctrl+Enter (Cmd+Enter on a Mac)
 * sends, or saves an edit, with Shift as well saving and resending.
 *
 * Run: npx vitest run src/lib/__tests__/enter-key-setting.test.ts
 */
import { describe, it, expect } from 'vitest'
import { composerHint, composerPlaceholder, composerSends, editKeyAction, editShortcuts, enterKeyMode, type KeyLike } from '../enter-key'
import { DEFAULT_SETTINGS } from '../constants'

const key = (over: Partial<KeyLike> = {}): KeyLike => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, ...over })

describe('the composer', () => {
  it('"Sends" (the default): Enter sends, Shift+Enter is a line', () => {
    expect(enterKeyMode(DEFAULT_SETTINGS.enterKey)).toBe('send')
    expect(composerSends(key(), 'send')).toBe(true)
    expect(composerSends(key({ ctrlKey: true }), 'send')).toBe(true)
    expect(composerSends(key({ shiftKey: true }), 'send')).toBe(false)
  })

  it('"New line": Enter is a line, Ctrl+Enter or Cmd+Enter sends', () => {
    expect(composerSends(key(), 'newline')).toBe(false)
    expect(composerSends(key({ shiftKey: true }), 'newline')).toBe(false)
    expect(composerSends(key({ ctrlKey: true }), 'newline')).toBe(true)
    expect(composerSends(key({ metaKey: true }), 'newline')).toBe(true)
  })

  it('a key the input method is still composing never sends', () => {
    expect(composerSends(key({ isComposing: true }), 'send')).toBe(false)
    expect(composerSends(key({ ctrlKey: true, isComposing: true }), 'newline')).toBe(false)
  })

  it('other keys never send', () => {
    expect(composerSends(key({ key: 'a' }), 'send')).toBe(false)
  })

  it('an unknown stored value is the default', () => {
    expect(enterKeyMode(undefined)).toBe('send')
    expect(enterKeyMode('weird')).toBe('send')
    expect(enterKeyMode('newline')).toBe('newline')
  })

  it('the hint names the shortcut, Cmd on a Mac', () => {
    expect(composerHint('send', true)).toBe('Enter sends, Shift+Enter adds a line')
    expect(composerHint('newline', true)).toBe('Cmd+Enter sends, Enter adds a line')
    expect(composerHint('newline', false)).toBe('Ctrl+Enter sends, Enter adds a line')
    expect(composerPlaceholder('send', false)).toBe('Message...')
    expect(composerPlaceholder('newline', false)).toBe('Message... (Ctrl+Enter to send)')
  })
})

describe('the edit field of an earlier message', () => {
  it('"Sends": Enter saves, Ctrl+Enter resends, Shift+Enter is a line', () => {
    expect(editKeyAction(key(), 'send')).toBe('save')
    expect(editKeyAction(key({ ctrlKey: true }), 'send')).toBe('resend')
    expect(editKeyAction(key({ shiftKey: true }), 'send')).toBe('none')
  })

  it('"New line": Enter is a line, Ctrl+Enter saves, Ctrl+Shift+Enter resends', () => {
    expect(editKeyAction(key(), 'newline')).toBe('none')
    expect(editKeyAction(key({ shiftKey: true }), 'newline')).toBe('none')
    expect(editKeyAction(key({ metaKey: true }), 'newline')).toBe('save')
    expect(editKeyAction(key({ ctrlKey: true, shiftKey: true }), 'newline')).toBe('resend')
    expect(editShortcuts('newline', true)).toEqual({ save: 'Cmd+Enter', resend: 'Cmd+Shift+Enter', hint: 'Cmd+Enter saves, Enter adds a line' })
  })
})
