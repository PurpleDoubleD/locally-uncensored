/**
 * Global keyboard shortcuts.
 *
 * Ctrl+N       — New conversation
 * Ctrl+L       — Focus chat input
 * Ctrl+E       — Export chat
 * Ctrl+/       — Show shortcuts help
 * Ctrl+Shift+D — Toggle dark/light mode
 * Escape       — Close any open panel/modal
 */

import { useEffect, useCallback } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { exportConversation } from '../lib/chat-export'

export function useKeyboardShortcuts() {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const isCtrl = e.ctrlKey || e.metaKey
    const isShift = e.shiftKey
    const tag = (e.target as HTMLElement).tagName

    // Don't interfere with input fields (except for Escape)
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable
    if (inInput && e.key !== 'Escape') return

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
