// W33 (Discord, 15.11.2026): a right click anywhere in LU opened the web
// view's own menu (Print, Reload, Save page as ...). In a release build that
// menu is off. Where there is text to work with, LU shows a plain menu of its
// own, the same on Mac, Windows and Linux: in a text field Cut, Copy, Paste
// and Select all; on selected text elsewhere Copy. A dev build keeps the web
// view's menu for Inspect. A part of LU with a menu of its own (a chat
// message, a model, a gallery tile) handles the click first and is left alone.

export type TextAction = 'cut' | 'copy' | 'paste' | 'selectAll'

/** What the right click landed on, read off the DOM (see `readTarget`). */
export interface TextTarget {
  /** An input that takes text, a textarea or a contenteditable element. */
  editable: boolean
  /** It takes no typing (readonly or disabled). */
  readOnly: boolean
  /** Text is selected in it, or on the page. */
  hasSelection: boolean
  /** It holds any text at all. */
  hasText: boolean
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'number', ''])

/** The actions of the menu, in this order; empty means no menu at all. */
export function textMenuActions(t: TextTarget): TextAction[] {
  if (t.editable) {
    const out: TextAction[] = []
    if (!t.readOnly && t.hasSelection) out.push('cut')
    if (t.hasSelection) out.push('copy')
    if (!t.readOnly) out.push('paste')
    if (t.hasText) out.push('selectAll')
    return out
  }
  return t.hasSelection ? ['copy'] : []
}

export const TEXT_ACTION_LABEL: Record<TextAction, string> = {
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
}

/** The field a right click is in, if it takes text. A password field is left
 *  out: its text is not copied out of it. */
export function editableOf(el: Element | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (!el) return null
  if (el instanceof HTMLTextAreaElement) return el
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) ? el : null
  const host = el.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]')
  return host instanceof HTMLElement ? host : null
}

export function readTarget(el: Element | null, selection: string): TextTarget {
  const field = editableOf(el)
  if (!field) return { editable: false, readOnly: true, hasSelection: selection.length > 0, hasText: false }
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const start = field.selectionStart ?? 0
    const end = field.selectionEnd ?? 0
    return { editable: true, readOnly: field.readOnly || field.disabled, hasSelection: end > start, hasText: field.value.length > 0 }
  }
  return { editable: true, readOnly: false, hasSelection: selection.length > 0, hasText: (field.textContent ?? '').length > 0 }
}

/** Does this build keep the web view's own menu? Only a dev build (Inspect). */
export function keepsNativeMenu(dev: boolean): boolean {
  return dev
}

// A33 (Discord, 17.11.2026): the web view's menu carried the spelling
// suggestions of the word under the click, and they went with it. LU's menu
// asks the system's checker (src-tauri/src/commands/spell.rs) and puts them
// on top, as the web view did.

const WORD_CHAR = /[\p{L}'’-]/u

/** The word a right click in a text field is about: the selection when it
 *  is one word, else the word around the caret. Null when there is none. */
export function wordAt(value: string, start: number, end: number): { word: string; from: number; to: number } | null {
  const trimEdges = (from: number, to: number) => {
    while (from < to && !/\p{L}/u.test(value[from])) from++
    while (to > from && !/\p{L}/u.test(value[to - 1])) to--
    return to > from ? { word: value.slice(from, to), from, to } : null
  }
  if (end > start) {
    const sel = value.slice(start, end)
    if (![...sel].every((c) => WORD_CHAR.test(c))) return null
    return trimEdges(start, end)
  }
  let from = Math.max(0, Math.min(start, value.length))
  let to = from
  while (from > 0 && WORD_CHAR.test(value[from - 1])) from--
  while (to < value.length && WORD_CHAR.test(value[to])) to++
  return trimEdges(from, to)
}

/** The menu's id of a suggestion, apart from the four text actions. */
export function spellActionId(i: number): string {
  return `spell-${i}`
}
