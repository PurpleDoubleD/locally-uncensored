// @vitest-environment jsdom
/**
 * T13d, Befund 4: der Satz unter dem Personen-Hauptschalter hat zwei Tester
 * hintereinander in die Irre gefuehrt. Er lautete
 * `Active persona is applied to new chats.` und versprach damit mehr, als der
 * Code tut: `chatStore.createConversation` legt jede neue Unterhaltung mit
 * `personaEnabled: false` an, und `system-prompt.ts` verlangt genau diese
 * Flagge, bevor der Text der Person in den Anfragekoerper kommt. Angewandt
 * wird die Person erst nach dem Schalter je Chat im Plugins-Menue.
 *
 * Run: npx vitest run src/components/personas/__tests__/der-personensatz-verspricht-nichts-falsches.test.tsx
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PersonaPanel } from '../PersonaPanel'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useChatStore } from '../../../stores/chatStore'

const SATZ = 'Active persona is available in every chat. Switch it on per chat in the Plugins menu.'
const ALTER_SATZ = 'Active persona is applied to new chats.'

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
})
afterEach(() => cleanup())

describe('der Satz unter dem Personen-Hauptschalter', () => {
  it('nennt den Schalter je Chat, nicht die neue Unterhaltung', () => {
    useSettingsStore.getState().updateSettings({ personasEnabled: true })
    render(<PersonaPanel />)
    expect(screen.getByText(SATZ)).toBeTruthy()
    // Negativkontrolle: der alte Satz darf nirgends mehr stehen. Kommt er
    // zurueck, faellt diese Zeile, nicht die daneben.
    expect(screen.queryByText(ALTER_SATZ), 'der widerlegte Satz steht wieder da').toBeNull()
  })

  it('sagt damit die Wahrheit: eine neue Unterhaltung startet ohne Person', () => {
    const id = useChatStore.getState().createConversation('gemma4:12b', '', 'lu')
    const conv = useChatStore.getState().conversations.find(c => c.id === id)
    expect(conv, 'die Unterhaltung wurde gar nicht angelegt').toBeTruthy()
    expect(conv!.personaEnabled, 'eine neue Unterhaltung traegt die Person schon eingeschaltet, dann waere der alte Satz wahr gewesen').toBe(false)
  })

  it('nennt das Menue bei dem Namen, den es auf dem Schirm traegt', () => {
    // Der Satz zeigt auf ein Menue. Steht dort ein anderer Name, schickt er
    // den Kunden ins Leere, also wird der Name gegen die Quelle gehalten.
    const quelle = readFileSync(join(__dirname, '../../chat/PluginsDropdown.tsx'), 'utf8')
    expect(quelle).toContain('>Plugins</span>')
    expect(quelle).toContain('aria-label="Plugins"')
    expect(quelle).toContain("'Enable persona for this chat'")
    expect(SATZ).toContain('Plugins menu')
  })

  it('laesst den Aus-Zustand unberuehrt', () => {
    useSettingsStore.getState().updateSettings({ personasEnabled: false })
    render(<PersonaPanel />)
    expect(screen.getByText('Off: raw model, no persona prompt.')).toBeTruthy()
    expect(screen.queryByText(SATZ), 'der Ein-Satz steht am ausgeschalteten Schalter').toBeNull()
  })
})
