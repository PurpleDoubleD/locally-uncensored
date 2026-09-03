/**
 * Tastenkürzel mit Modifier dürfen nicht am Eingabefeld hängenbleiben (Welle 2)
 *
 * Die `isCtrl`-Prüfung stand HINTER dem Eingabefeld-Guard, also verschluckte
 * jedes fokussierte Textfeld sämtliche Kürzel mit Ctrl/Cmd — und in dieser App
 * hat fast immer das Chat-Eingabefeld den Fokus. Ctrl+N und Ctrl+E waren damit
 * praktisch tot.
 *
 * Beim Vorziehen darf das Tippen nicht kaputtgehen: Cmd+A/C/V/X/Z gehören
 * weiterhin dem Feld, und unter macOS auch die Emacs-Bindings auf Ctrl.
 *
 * Run: npx vitest run src/hooks/__tests__/shortcut-owner.test.ts
 */
import { describe, it, expect } from 'vitest'
import { shortcutOwner } from '../useKeyboardShortcuts'

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean } = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
})

const WIN = false
const MAC = true

describe('shortcutOwner — außerhalb eines Eingabefelds', () => {
  it('gibt der App jede Taste', () => {
    expect(shortcutOwner(key('n'), false, WIN)).toBe('app')
    expect(shortcutOwner(key('n', { ctrl: true }), false, WIN)).toBe('app')
    expect(shortcutOwner(key('a', { meta: true }), false, MAC)).toBe('app')
  })
})

describe('shortcutOwner — im Eingabefeld', () => {
  it('lässt getippte Zeichen beim Feld (der eigentliche Zweck des Guards)', () => {
    expect(shortcutOwner(key('n'), true, WIN)).toBe('field')
    expect(shortcutOwner(key('e'), true, WIN)).toBe('field')
    expect(shortcutOwner(key(' '), true, WIN)).toBe('field')
  })

  it('gibt Kürzel MIT Modifier an die App — das war der Fehler', () => {
    expect(shortcutOwner(key('n', { ctrl: true }), true, WIN)).toBe('app')
    expect(shortcutOwner(key('e', { ctrl: true }), true, WIN)).toBe('app')
    expect(shortcutOwner(key('l', { ctrl: true }), true, WIN)).toBe('app')
    expect(shortcutOwner(key('/', { ctrl: true }), true, WIN)).toBe('app')
    expect(shortcutOwner(key('D', { ctrl: true }), true, WIN)).toBe('app')
  })

  it('lässt Cmd+A, Cmd+C, Cmd+V, Cmd+X, Cmd+Z beim Textfeld', () => {
    for (const k of ['a', 'c', 'v', 'x', 'z']) {
      expect(shortcutOwner(key(k, { meta: true }), true, MAC)).toBe('field')
      expect(shortcutOwner(key(k, { ctrl: true }), true, WIN)).toBe('field')
    }
  })

  it('lässt auch Cmd+Shift+Z (Wiederherstellen) beim Feld — Groß/Klein egal', () => {
    expect(shortcutOwner(key('Z', { meta: true }), true, MAC)).toBe('field')
    expect(shortcutOwner(key('y', { ctrl: true }), true, WIN)).toBe('field')
  })

  it('lässt wortweises Springen und Löschen beim Feld', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete']) {
      expect(shortcutOwner(key(k, { ctrl: true }), true, WIN)).toBe('field')
      expect(shortcutOwner(key(k, { meta: true }), true, MAC)).toBe('field')
    }
  })

  it('macOS: die Emacs-Bindings auf Ctrl bleiben beim Feld (Ctrl+E = Zeilenende)', () => {
    expect(shortcutOwner(key('e', { ctrl: true }), true, MAC)).toBe('field')
    expect(shortcutOwner(key('n', { ctrl: true }), true, MAC)).toBe('field')
    expect(shortcutOwner(key('k', { ctrl: true }), true, MAC)).toBe('field')
  })

  it('macOS: die App-Kürzel laufen dort über Cmd und kommen weiterhin durch', () => {
    expect(shortcutOwner(key('n', { meta: true }), true, MAC)).toBe('app')
    expect(shortcutOwner(key('e', { meta: true }), true, MAC)).toBe('app')
  })

  it('Windows/Linux: Ctrl+E bleibt ein App-Kürzel (dort gibt es keine Emacs-Bindings)', () => {
    expect(shortcutOwner(key('e', { ctrl: true }), true, WIN)).toBe('app')
    expect(shortcutOwner(key('n', { ctrl: true }), true, WIN)).toBe('app')
  })

  it('Escape kommt immer durch, auch aus einem Eingabefeld heraus', () => {
    expect(shortcutOwner(key('Escape'), true, MAC)).toBe('app')
    expect(shortcutOwner(key('Escape'), true, WIN)).toBe('app')
  })
})
