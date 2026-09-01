/**
 * Global keyboard shortcuts.
 *
 * Ctrl+N       — New conversation
 * Ctrl+L       — Focus chat input
 * Ctrl+E       — Export chat
 * Ctrl+/       — Show shortcuts help
 * Ctrl+Shift+D — Toggle dark/light mode
 * Escape       — Close any open panel/modal
 *
 * Escape wird NICHT hier behandelt: seit Welle 2 schließt ui/Modal sich selbst
 * und kennt dabei den Dialog-Stapel, schließt also nur den obersten. Ein
 * zweiter Escape-Handler an dieser Stelle würde zwei Ebenen auf einmal zumachen.
 */

import { useEffect, useCallback } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { exportConversation } from '../lib/chat-export'

/** Die Teilmenge eines KeyboardEvent, die der Besitz-Entscheidung reicht. */
export interface ShortcutKeyEvent {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

/**
 * Tastenkombinationen, die IMMER dem fokussierten Textfeld gehören — die
 * Bearbeitungsbefehle des Systems. Ohne diese Liste würde ein Kürzel-Handler,
 * der Modifier-Tasten auch im Eingabefeld auswertet, Cmd+A/C/V/X/Z schlucken.
 */
export const EDITING_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y'])

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete'])

/**
 * Wem gehört dieser Tastendruck: der App (globales Kürzel) oder dem Feld?
 *
 * Vorher stand die `isCtrl`-Prüfung HINTER dem Eingabefeld-Guard, also wurde
 * jedes Kürzel mit Modifier verschluckt, solange irgendein Feld den Fokus
 * hatte — und in dieser App hat fast immer das Chat-Eingabefeld den Fokus.
 * Ctrl+N/Ctrl+E waren damit praktisch tot.
 *
 * Umgekehrt darf das Vorziehen das Tippen nicht kaputtmachen, deshalb die
 * beiden Ausnahmen unten.
 */
export function shortcutOwner(e: ShortcutKeyEvent, inInput: boolean, isMac: boolean): 'app' | 'field' {
  if (e.key === 'Escape') return 'app'
  if (!inInput) return 'app'

  const isCtrl = e.ctrlKey || e.metaKey
  if (!isCtrl) return 'field'

  // (1) Bearbeitungsbefehle: Cmd/Ctrl + A C V X Z Y und die Navigationstasten
  //     bleiben beim Feld, sonst kann man im Textfeld nicht mehr arbeiten.
  if (EDITING_KEYS.has(e.key.toLowerCase())) return 'field'
  if (NAV_KEYS.has(e.key)) return 'field'

  // (2) macOS: in Textfeldern sind die Ctrl-Tasten die Emacs-Bindings des
  //     Systems (Ctrl+E = Zeilenende, Ctrl+N = Zeile runter, Ctrl+A = Anfang).
  //     Die App-Kürzel laufen dort ohnehin über Cmd, also bekommt Ctrl-ohne-Cmd
  //     das Feld zurück und die Cursorbewegung bleibt heil.
  if (isMac && e.ctrlKey && !e.metaKey) return 'field'

  return 'app'
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent || '')

export function useKeyboardShortcuts() {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const isCtrl = e.ctrlKey || e.metaKey
    const isShift = e.shiftKey
    const tag = (e.target as HTMLElement).tagName

    // Don't interfere with input fields — but a shortcut WITH a modifier is not
    // typing, so it is decided by shortcutOwner() instead of a blanket return.
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable
    if (shortcutOwner(e, inInput, IS_MAC) === 'field') return

    // Ctrl+N — New conversation
    if (isCtrl && e.key === 'n') {
      e.preventDefault()
      const model = useModelStore.getState().activeModel
      const persona = useSettingsStore.getState().getActivePersona()
      if (model) {
        // Same field mix-up as useABCompare had: `Persona.systemPrompt`.
        // Ctrl+N used to open every chat with an empty system prompt.
        useChatStore.getState().createConversation(model, persona?.systemPrompt || '')
      }
      useUIStore.getState().setView('chat')
    }

    // Ctrl+L — Focus chat input
    if (isCtrl && e.key === 'l') {
      e.preventDefault()
      const input = document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="Message"]')
      input?.focus()
    }

    // Ctrl+E — Export chat
    if (isCtrl && e.key === 'e') {
      e.preventDefault()
      const state = useChatStore.getState()
      const conv = state.conversations.find(c => c.id === state.activeConversationId)
      if (conv) exportConversation(conv, 'markdown')
    }

    // Ctrl+Shift+D — Toggle theme
    if (isCtrl && isShift && e.key === 'D') {
      e.preventDefault()
      const settings = useSettingsStore.getState().settings
      useSettingsStore.getState().updateSettings({
        theme: settings.theme === 'dark' ? 'light' : 'dark',
      })
    }

    // Ctrl+/ — Show shortcuts help (dispatches custom event)
    if (isCtrl && e.key === '/') {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('lu-show-shortcuts'))
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

export const SHORTCUTS = [
  { keys: 'Ctrl+N', description: 'New conversation' },
  { keys: 'Ctrl+L', description: 'Focus chat input' },
  { keys: 'Ctrl+E', description: 'Export chat as Markdown' },
  { keys: 'Ctrl+Shift+D', description: 'Toggle dark/light mode' },
  { keys: 'Ctrl+/', description: 'Show keyboard shortcuts' },
  { keys: 'Escape', description: 'Close panel or modal' },
]
