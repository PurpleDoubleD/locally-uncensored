/**
 * GH #202: what the Enter key does in the chat composer and in the edit field
 * of an earlier message.
 *
 *  - 'send' (the default, as always): Enter sends, or saves an edit; Shift with
 *    Enter is a new line. In an edit Ctrl or Cmd with Enter saves and resends.
 *  - 'newline': Enter is a new line. Ctrl+Enter (Cmd+Enter on a Mac) sends,
 *    or saves an edit; with Shift as well it saves and resends.
 *
 * A key pressed while an input method is still composing (Japanese, Chinese,
 * Korean) belongs to the input method and does nothing here.
 */
export type EnterKeyMode = 'send' | 'newline'

export const DEFAULT_ENTER_KEY: EnterKeyMode = 'send'

export interface KeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey?: boolean
  isComposing?: boolean
}

/** A stored value as a mode; anything else is the default. */
export function enterKeyMode(value: unknown): EnterKeyMode {
  return value === 'newline' ? 'newline' : DEFAULT_ENTER_KEY
}

const isEnter = (e: KeyLike) => e.key === 'Enter' && !e.isComposing && !e.altKey
const withMod = (e: KeyLike) => e.ctrlKey || e.metaKey

/** Whether this key sends the composer's message. */
export function composerSends(e: KeyLike, mode: EnterKeyMode): boolean {
  if (!isEnter(e) || e.shiftKey) return false
  return mode === 'send' ? true : withMod(e)
}

/** What this key does in the edit field of an earlier message. */
export function editKeyAction(e: KeyLike, mode: EnterKeyMode): 'save' | 'resend' | 'none' {
  if (!isEnter(e)) return 'none'
  if (mode === 'send') {
    if (e.shiftKey) return 'none'
    return withMod(e) ? 'resend' : 'save'
  }
  if (!withMod(e)) return 'none'
  return e.shiftKey ? 'resend' : 'save'
}

const modName = (mac: boolean) => (mac ? 'Cmd' : 'Ctrl')

/** The composer's hint: how to send and how to break a line. */
export function composerHint(mode: EnterKeyMode, mac: boolean): string {
  return mode === 'send'
    ? 'Enter sends, Shift+Enter adds a line'
    : `${modName(mac)}+Enter sends, Enter adds a line`
}

/** The same, short enough for the composer's placeholder in a narrow window. */
export function composerShortHint(mode: EnterKeyMode, mac: boolean): string {
  return mode === 'send' ? 'Enter to send' : `${modName(mac)}+Enter to send`
}

/** The composer's placeholder. In the default mode it stays the plain
 *  "Message..." everyone knows; in "new line" mode it says how to send. */
export function composerPlaceholder(mode: EnterKeyMode, mac: boolean): string {
  return mode === 'send' ? 'Message...' : `Message... (${composerShortHint(mode, mac)})`
}

/** The shortcuts of the edit field's two buttons, for their titles. */
export function editShortcuts(mode: EnterKeyMode, mac: boolean): { save: string; resend: string; hint: string } {
  const m = modName(mac)
  return mode === 'send'
    ? { save: 'Enter', resend: `${m}+Enter`, hint: 'Enter saves, Shift+Enter adds a line' }
    : { save: `${m}+Enter`, resend: `${m}+Shift+Enter`, hint: `${m}+Enter saves, Enter adds a line` }
}
