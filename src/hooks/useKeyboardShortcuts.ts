/**
 * Global keyboard shortcuts.
 *
 * Ctrl+K       — Command palette
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
 *
 * DIE Regel dieser Datei (Welle 3, Achse 11): es gibt genau EINEN
 * Tastatur-Handler und genau EINE Zuordnung Taste → Aktion. Die Kommandopalette
 * hängt sich deshalb NICHT mit einem zweiten `keydown`-Listener daneben,
 * sondern bekommt hier ihren Eintrag (`command-palette`) und ruft für alles
 * Weitere dieselben Funktionen aus `SHORTCUT_ACTIONS`, die auch die Taste ruft.
 * Zwei Handler auf demselben Ereignis sind das Muster, das dieses Projekt
 * schon mehrfach bezahlt hat: einer wird gepflegt, der andere driftet.
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

/** Jede Aktion, die dieser App über eine Taste erreichbar ist. */
export type ShortcutId =
  | 'command-palette'
  | 'new-conversation'
  | 'focus-chat-input'
  | 'export-chat'
  | 'toggle-theme'
  | 'show-shortcuts'

/** Ein Tastendruck, soweit die Zuordnung ihn liest. */
export interface ShortcutChord extends ShortcutKeyEvent {
  readonly shiftKey: boolean
}

/**
 * Welche Aktion löst dieser Tastendruck aus — oder keine?
 *
 * Die Besitz-Entscheidung aus `shortcutOwner` steht als erstes darin, damit es
 * unmöglich wird, ein Kürzel hinzuzufügen, das den Guard umgeht. Vorher lag die
 * Zuordnung als Kette von `if`s im `keydown`-Handler und war damit nur mit
 * einem DOM prüfbar; hier ist sie eine reine Funktion und wird im Test
 * durchgerechnet.
 */
export function shortcutCommandFor(e: ShortcutChord, inInput: boolean, isMac: boolean): ShortcutId | null {
  if (shortcutOwner(e, inInput, isMac) === 'field') return null
  if (!(e.ctrlKey || e.metaKey)) return null

  // Das einzige Kürzel, das Shift BRAUCHT. `e.key` ist das geschaltete
  // Zeichen, also das große D — genau wie in der Fassung davor.
  if (e.shiftKey && e.key === 'D') return 'toggle-theme'

  switch (e.key) {
    case 'k': return 'command-palette'
    case 'n': return 'new-conversation'
    case 'l': return 'focus-chat-input'
    case 'e': return 'export-chat'
    // Auf dem deutschen Layout IST `/` bereits Shift+7. Dieser Fall darf
    // deshalb nicht hinter einer `!shiftKey`-Sperre liegen, sonst wäre Ctrl+/
    // dort tot — und die Tastatur dieses Hauses ist deutsch.
    case '/': return 'show-shortcuts'
    default: return null
  }
}

/**
 * Was die Aktionen TUN. Eine Funktion je Aktion, und zwar die einzige:
 * der Tastatur-Handler unten ruft sie, und die Kommandopalette
 * (`ui/command-actions.ts`) reicht dieselben Funktionsobjekte als ihr `run`
 * weiter. Es gibt bewusst keine zweite Fassung „für die Palette".
 */
export const SHORTCUT_ACTIONS: Readonly<Record<ShortcutId, () => void>> = {
  'command-palette': () => {
    window.dispatchEvent(new CustomEvent('lu-command-palette'))
  },

  'new-conversation': () => {
    const model = useModelStore.getState().activeModel
    const persona = useSettingsStore.getState().getActivePersona()
    if (model) {
      // Same field mix-up as useABCompare had: `Persona.systemPrompt`.
      // Ctrl+N used to open every chat with an empty system prompt.
      useChatStore.getState().createConversation(model, persona?.systemPrompt || '')
    }
    useUIStore.getState().setView('chat')
  },

  'focus-chat-input': () => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="Message"]')
    input?.focus()
  },

  'export-chat': () => {
    const state = useChatStore.getState()
    const conv = state.conversations.find(c => c.id === state.activeConversationId)
    if (conv) void exportConversation(conv, 'markdown')
  },

  'toggle-theme': () => {
    const settings = useSettingsStore.getState().settings
    useSettingsStore.getState().updateSettings({
      theme: settings.theme === 'dark' ? 'light' : 'dark',
    })
  },

  'show-shortcuts': () => {
    window.dispatchEvent(new CustomEvent('lu-show-shortcuts'))
  },
}

export function useKeyboardShortcuts() {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    const tag = target?.tagName ?? ''

    // Don't interfere with input fields — but a shortcut WITH a modifier is not
    // typing, so it is decided by shortcutOwner() (inside shortcutCommandFor)
    // instead of a blanket return.
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true

    const id = shortcutCommandFor(e, inInput, IS_MAC)
    if (!id) return
    e.preventDefault()
    SHORTCUT_ACTIONS[id]()
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

/** Ein Eintrag der Kürzel-Übersicht. `id` fehlt nur, wo keine Aktion dahinter
 *  steht (Escape gehört dem Dialog, nicht diesem Handler). */
export interface ShortcutEntry {
  readonly id: ShortcutId | null
  readonly keys: string
  readonly description: string
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: 'command-palette', keys: 'Ctrl+K', description: 'Command palette' },
  { id: 'new-conversation', keys: 'Ctrl+N', description: 'New conversation' },
  { id: 'focus-chat-input', keys: 'Ctrl+L', description: 'Focus chat input' },
  { id: 'export-chat', keys: 'Ctrl+E', description: 'Export chat as Markdown' },
  { id: 'toggle-theme', keys: 'Ctrl+Shift+D', description: 'Toggle dark/light mode' },
  { id: 'show-shortcuts', keys: 'Ctrl+/', description: 'Show keyboard shortcuts' },
  { id: null, keys: 'Escape', description: 'Close panel or modal' },
]

/** Die Beschriftung eines Kürzels — EINE Liste, keine zweite Tabelle für die
 *  Palette. */
export function shortcutKeys(id: ShortcutId): string | undefined {
  return SHORTCUTS.find(s => s.id === id)?.keys
}
