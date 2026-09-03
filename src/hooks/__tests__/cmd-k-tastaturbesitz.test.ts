/**
 * Cmd+K gehört der App, Cmd+A gehört dem Feld — Audit Welle 3, Achse 11.
 *
 * Eine Kommandopalette scheitert fast immer an derselben Stelle: sie macht
 * einen ZWEITEN `keydown`-Listener auf. Dann streiten zwei Handler um
 * dasselbe Ereignis, und wer im Composer steht, bekommt entweder seine
 * Palette nicht oder verliert Cmd+A/C/V.
 *
 * Dieser Test prüft beide Richtungen an DER Funktion, die es entscheidet, und
 * belegt zusätzlich, dass es die einzige Entscheidung geblieben ist.
 *
 * Run: npx vitest run src/hooks/__tests__/cmd-k-tastaturbesitz.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SHORTCUTS,
  SHORTCUT_ACTIONS,
  shortcutCommandFor,
  shortcutKeys,
  type ShortcutId,
} from '../useKeyboardShortcuts'

const chord = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
})

const WIN = false
const MAC = true
const IN_FIELD = true
const FREE = false

const SRC = resolve(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

describe('Cmd+K wird vom Composer nicht geschluckt', () => {
  it('öffnet die Palette auch aus einem Textfeld heraus', () => {
    expect(shortcutCommandFor(chord('k', { meta: true }), IN_FIELD, MAC)).toBe('command-palette')
    expect(shortcutCommandFor(chord('k', { ctrl: true }), IN_FIELD, WIN)).toBe('command-palette')
  })

  it('und erst recht außerhalb', () => {
    expect(shortcutCommandFor(chord('k', { meta: true }), FREE, MAC)).toBe('command-palette')
    expect(shortcutCommandFor(chord('k', { ctrl: true }), FREE, WIN)).toBe('command-palette')
  })

  it('ein blankes k tippt weiterhin ein k', () => {
    expect(shortcutCommandFor(chord('k'), IN_FIELD, MAC)).toBeNull()
    expect(shortcutCommandFor(chord('k'), IN_FIELD, WIN)).toBeNull()
  })

  it('macOS: Ctrl+K im Feld bleibt die Emacs-Bindung (Zeile ab Cursor löschen)', () => {
    // Das ist kein Versehen: die App-Kürzel laufen auf dem Mac über Cmd.
    expect(shortcutCommandFor(chord('k', { ctrl: true }), IN_FIELD, MAC)).toBeNull()
  })
})

describe('die Palette schluckt ihrerseits nichts', () => {
  it('Cmd/Ctrl + A C V X Z Y bleiben im Feld unbeantwortet', () => {
    for (const k of ['a', 'c', 'v', 'x', 'z', 'y']) {
      expect(shortcutCommandFor(chord(k, { meta: true }), IN_FIELD, MAC)).toBeNull()
      expect(shortcutCommandFor(chord(k, { ctrl: true }), IN_FIELD, WIN)).toBeNull()
    }
  })

  it('auch Cmd+Shift+Z und die Navigationstasten', () => {
    expect(shortcutCommandFor(chord('Z', { meta: true, shift: true }), IN_FIELD, MAC)).toBeNull()
    for (const k of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete']) {
      expect(shortcutCommandFor(chord(k, { meta: true }), IN_FIELD, MAC)).toBeNull()
      expect(shortcutCommandFor(chord(k, { ctrl: true }), IN_FIELD, WIN)).toBeNull()
    }
  })

  it('kein Buchstabe ohne Modifier löst je etwas aus', () => {
    for (const k of 'abcdefghijklmnopqrstuvwxyz') {
      expect(shortcutCommandFor(chord(k), FREE, WIN)).toBeNull()
    }
  })
})

describe('die alten Kürzel sind beim Umbau nicht verlorengegangen', () => {
  it('Ctrl+N / Ctrl+L / Ctrl+E / Ctrl+Shift+D / Ctrl+/', () => {
    expect(shortcutCommandFor(chord('n', { ctrl: true }), IN_FIELD, WIN)).toBe('new-conversation')
    expect(shortcutCommandFor(chord('l', { ctrl: true }), IN_FIELD, WIN)).toBe('focus-chat-input')
    expect(shortcutCommandFor(chord('e', { ctrl: true }), IN_FIELD, WIN)).toBe('export-chat')
    expect(shortcutCommandFor(chord('D', { ctrl: true, shift: true }), IN_FIELD, WIN)).toBe('toggle-theme')
    expect(shortcutCommandFor(chord('/', { ctrl: true }), IN_FIELD, WIN)).toBe('show-shortcuts')
  })

  it('Ctrl+/ überlebt das deutsche Layout, wo `/` selbst Shift+7 ist', () => {
    // Eine `!shiftKey`-Sperre vor der Tabelle hätte Ctrl+/ auf jeder
    // deutschen Tastatur getötet — und das ist die Tastatur dieses Hauses.
    expect(shortcutCommandFor(chord('/', { ctrl: true, shift: true }), FREE, WIN)).toBe('show-shortcuts')
  })

  it('Escape bleibt beim Dialog-Stapel und nicht bei diesem Handler', () => {
    expect(shortcutCommandFor(chord('Escape'), IN_FIELD, MAC)).toBeNull()
    expect(shortcutCommandFor(chord('Escape'), FREE, WIN)).toBeNull()
  })
})

describe('eine Taste, eine Aktion, eine Liste', () => {
  const ids: ShortcutId[] = [
    'command-palette', 'new-conversation', 'focus-chat-input',
    'export-chat', 'toggle-theme', 'show-shortcuts',
  ]

  it('jede Aktion ist ausführbar und steht in der Kürzel-Übersicht', () => {
    for (const id of ids) {
      expect(typeof SHORTCUT_ACTIONS[id]).toBe('function')
      expect(shortcutKeys(id)).toBeTruthy()
    }
  })

  it('die Übersicht erfindet keine Aktion, die es nicht gibt', () => {
    for (const entry of SHORTCUTS) {
      if (entry.id === null) continue
      expect(SHORTCUT_ACTIONS[entry.id]).toBeTypeOf('function')
    }
  })

  it('Ctrl+K steht mit drin — ein unsichtbares Kürzel ist ein totes Kürzel', () => {
    expect(SHORTCUTS.find(s => s.id === 'command-palette')?.keys).toBe('Ctrl+K')
  })
})

describe('es gibt weiterhin GENAU EINEN Tastatur-Handler', () => {
  it('nur useKeyboardShortcuts hängt an keydown auf window', () => {
    const hook = read('hooks', 'useKeyboardShortcuts.ts')
    expect(hook.match(/window\.addEventListener\('keydown'/g)).toHaveLength(1)
  })

  it('die Palette macht keinen zweiten auf — sie hört auf ihr Ereignis', () => {
    const palette = read('components', 'ui', 'CommandPalette.tsx')
    expect(palette).not.toMatch(/addEventListener\(\s*'keydown'/)
    expect(palette).toContain("window.addEventListener('lu-command-palette'")
  })

  it('und der Handler ruft die Aktion über die Tabelle, nicht über eine if-Kette', () => {
    const hook = read('hooks', 'useKeyboardShortcuts.ts')
    expect(hook).toContain('const id = shortcutCommandFor(e, inInput, IS_MAC)')
    expect(hook).toContain('SHORTCUT_ACTIONS[id]()')
  })
})
