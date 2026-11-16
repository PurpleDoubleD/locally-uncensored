/**
 * @vitest-environment jsdom
 *
 * 3.1.0, David 16.11.2026: every plugin under Plugins gets the switch Neurons
 * has, at the far right of its row, in Chat, Agent and Code. Off closes the
 * row; on opens what the plugin had in its dropdown right under it. What a
 * user had switched on before stays on: the switches read the same fields
 * the old dropdowns wrote, nothing is migrated away.
 *
 * And the Neurons hint: a small calm dot on the Plugins button until Plugins
 * was opened AND Neurons was on once, the same dot on the Neurons row until
 * it was on once. Remembered on this computer, gone with one constant in
 * 3.1.1 (lib/neurons-hint.ts).
 *
 * Run: npx vitest run src/components/chat/__tests__/every-plugin-has-its-switch.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../../api/backend', async (orig) => ({ ...(await orig<typeof import('../../../api/backend')>()), isTauri: () => true }))

import { PluginsDropdown, PERSONA_NO_CHAT_REASON, GROUP_NO_CHAT_REASON, cavemanLevelOf } from '../PluginsDropdown'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useChatStore } from '../../../stores/chatStore'
import { useModelStore } from '../../../stores/modelStore'
import { useNeuronWindow } from '../../../stores/neuronWindowStore'
import { BUILT_IN_PERSONAS, DEFAULT_SETTINGS } from '../../../lib/constants'
import { NEURONS_HINT_KEY, neuronsHintDots, useNeuronsHint } from '../../../lib/neurons-hint'
import type { AIModel } from '../../../types/models'

const SURFACES: { name: string; props: { openUpward?: boolean; iconOnly?: boolean; agentTools?: boolean } }[] = [
  { name: 'Chat', props: { openUpward: true } },
  { name: 'Agent', props: { openUpward: true, agentTools: true } },
  { name: 'Code', props: { iconOnly: true, agentTools: true } },
]

const textModel = (name: string): AIModel => ({ name, type: 'text' } as AIModel)

let convId = ''
beforeEach(() => {
  localStorage.clear()
  useNeuronsHint.setState({ menuOpened: false, neuronsOnce: false })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'local' }, personas: [...BUILT_IN_PERSONAS] })
  useModelStore.setState({ models: [textModel('walt'), textModel('baron')], activeModel: 'walt' })
  useChatStore.setState({ conversations: [], activeConversationId: null })
  convId = useChatStore.getState().createConversation('walt', '')
  useChatStore.getState().setActiveConversation(convId)
  useNeuronWindow.setState({ open: false, collapsed: false, pos: null })
})
afterEach(() => cleanup())

const openMenu = (props: object = { openUpward: true }) => {
  const r = render(<PluginsDropdown {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
  return r
}
const row = (id: string) => screen.getByTestId(`plugins-${id}`)
const switchOf = (id: string) => screen.getByTestId(`plugins-${id}-switch`)
const body = (id: string) => screen.queryByTestId(`plugins-${id}-body`)
const conversation = () => useChatStore.getState().conversations.find((c) => c.id === convId)!

describe('every plugin row has the switch at its right end', () => {
  for (const s of SURFACES) {
    it(`${s.name}: every row, one look, all closed while off`, async () => {
      openMenu(s.props)
      const ids = ['neurons', 'caveman', 'persona', 'group', ...(s.props.agentTools ? ['rea'] : [])]
      if (s.props.agentTools) await screen.findByTestId('plugins-rea')
      const looks = new Set<string>()
      for (const id of ids) {
        const sw = switchOf(id)
        // The switch is the last control of the row's head, at the right.
        expect(sw.parentElement!.lastElementChild).toBe(sw)
        expect(sw.getAttribute('aria-pressed')).toBe('false')
        looks.add(sw.className)
        expect(body(id), `${id} is closed while off`).toBeNull()
      }
      expect(looks.size, 'every switch looks the same').toBe(1)
    })
  }

  it('the rows are parted by hairlines, not boxed', () => {
    openMenu()
    const list = row('caveman').parentElement!
    expect(list.className).toContain('divide-y')
    for (const id of ['neurons', 'caveman', 'persona', 'group']) {
      expect(row(id).className).not.toMatch(/\bborder\b|rounded|shadow/)
    }
  })

  it('Caveman: on opens the levels, a level is kept, off closes and remembers it', () => {
    openMenu()
    fireEvent.click(switchOf('caveman'))
    expect(useSettingsStore.getState().settings.cavemanMode).toBe('lite')
    expect(body('caveman')).not.toBeNull()
    fireEvent.click(screen.getByTestId('plugins-caveman-ultra'))
    expect(useSettingsStore.getState().settings.cavemanMode).toBe('ultra')
    fireEvent.click(switchOf('caveman'))
    expect(useSettingsStore.getState().settings.cavemanMode).toBe('off')
    expect(body('caveman')).toBeNull()
    fireEvent.click(switchOf('caveman'))
    expect(useSettingsStore.getState().settings.cavemanMode).toBe('ultra')
  })

  it('Persona: on is THIS chat on, the list opens under it and picks', () => {
    openMenu()
    fireEvent.click(switchOf('persona'))
    expect(conversation().personaEnabled).toBe(true)
    const list = body('persona')!
    const pick = BUILT_IN_PERSONAS.find((p) => p.id !== 'unrestricted')!
    fireEvent.click(within(list).getByRole('button', { name: pick.name }))
    expect(useSettingsStore.getState().activePersonaId).toBe(pick.id)
    fireEvent.click(switchOf('persona'))
    expect(conversation().personaEnabled).toBe(false)
    expect(body('persona')).toBeNull()
  })

  it('Persona and Group chat without an open chat: grey, with the reason', () => {
    useChatStore.setState({ activeConversationId: null })
    openMenu()
    expect((switchOf('persona') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('plugins-persona-reason').textContent).toBe(PERSONA_NO_CHAT_REASON)
    expect((switchOf('group') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('plugins-group-reason').textContent).toBe(GROUP_NO_CHAT_REASON)
  })

  it('Group chat: on opens the list, off ends the group', () => {
    openMenu()
    fireEvent.click(switchOf('group'))
    expect(screen.getAllByTestId('group-participant')).toHaveLength(2)
    for (const m of ['walt', 'baron']) fireEvent.click(within(body('group')!).getByRole('button', { name: m }))
    expect(conversation().groupModels).toEqual(['walt', 'baron'])
    fireEvent.click(switchOf('group'))
    expect(conversation().groupModels ?? []).toEqual([])
    expect(body('group')).toBeNull()
  })

  it('Group chat switched on with nobody picked is off again after the menu closed', () => {
    openMenu()
    fireEvent.click(switchOf('group'))
    expect(switchOf('group').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
    fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
    expect(switchOf('group').getAttribute('aria-pressed')).toBe('false')
  })

  it('Neurons and REA open their lines under the row while on', async () => {
    useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: true, reaPluginEnabled: true })
    openMenu({ openUpward: true, agentTools: true })
    expect(within(body('neurons')!).getByTestId('plugins-neurons-open')).toBeTruthy()
    await screen.findByTestId('plugins-rea')
    expect(switchOf('rea').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('what users had on stays on (no migration loses anything)', () => {
  it('a stored Caveman level, a persona on in a chat, a group, Neurons and REA all show on', async () => {
    useSettingsStore.getState().updateSettings({ cavemanMode: 'full', neuronsPluginEnabled: true, reaPluginEnabled: true })
    useChatStore.getState().setConversationPersonaEnabled(convId, true)
    useChatStore.getState().setGroupModels(convId, ['walt', 'baron'])
    const before = JSON.stringify({ s: useSettingsStore.getState().settings, c: conversation() })
    openMenu({ openUpward: true, agentTools: true })
    await screen.findByTestId('plugins-rea')
    for (const id of ['caveman', 'persona', 'group', 'neurons', 'rea']) {
      expect(switchOf(id).getAttribute('aria-pressed'), id).toBe('true')
    }
    expect(screen.getByTestId('plugins-caveman-full').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByTestId('group-order-row')).toHaveLength(2)
    // Opening the menu wrote nothing.
    expect(JSON.stringify({ s: useSettingsStore.getState().settings, c: conversation() })).toBe(before)
  })

  it('the Caveman level reads defensively', () => {
    expect(cavemanLevelOf('full', undefined)).toBe('full')
    expect(cavemanLevelOf('off', 'ultra')).toBe('ultra')
    expect(cavemanLevelOf('off', 'loud')).toBe('lite')
    expect(cavemanLevelOf(undefined, undefined)).toBe('lite')
  })
})

describe('the Neurons hint (3.1.0, remove in 3.1.1)', () => {
  for (const s of SURFACES) {
    it(`${s.name}: dot on the button until Plugins was opened and Neurons on once`, () => {
      render(<PluginsDropdown {...s.props} />)
      expect(screen.getByTestId('plugins-hint')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
      // Opened, but Neurons never on: both dots stay.
      expect(screen.getByTestId('plugins-hint')).toBeTruthy()
      expect(within(row('neurons')).getByTestId('plugins-neurons-hint')).toBeTruthy()
      // On opens the Neurons window and closes the menu.
      fireEvent.click(switchOf('neurons'))
      expect(useNeuronWindow.getState().open).toBe(true)
      expect(screen.queryByTestId('plugins-hint')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
      expect(screen.queryByTestId('plugins-neurons-hint')).toBeNull()
      // Off again does not bring it back.
      fireEvent.click(switchOf('neurons'))
      expect(screen.queryByTestId('plugins-hint')).toBeNull()
      expect(screen.queryByTestId('plugins-neurons-hint')).toBeNull()
    })
  }

  it('Neurons on once without opening Plugins keeps the button dot only', () => {
    useNeuronsHint.setState({ neuronsOnce: true })
    render(<PluginsDropdown openUpward />)
    expect(screen.getByTestId('plugins-hint')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
    expect(screen.queryByTestId('plugins-neurons-hint')).toBeNull()
    expect(screen.queryByTestId('plugins-hint')).toBeNull()
  })

  it('is remembered on this computer', () => {
    openMenu()
    fireEvent.click(switchOf('neurons'))
    const saved = JSON.parse(localStorage.getItem(NEURONS_HINT_KEY) ?? '{}')
    expect(saved.state).toEqual({ menuOpened: true, neuronsOnce: true })
  })

  it('is calm: no pulse, no number', () => {
    openMenu()
    for (const dot of [screen.getByTestId('plugins-hint'), screen.getByTestId('plugins-neurons-hint')]) {
      expect(dot.className).not.toMatch(/animate|ping|pulse/)
      expect(dot.textContent).toBe('')
    }
  })

  it('shows nowhere Neurons cannot be turned on, and not when switched off', () => {
    const fresh = { menuOpened: false, neuronsOnce: false }
    expect(neuronsHintDots(fresh, true, false)).toEqual({ trigger: true, row: true })
    expect(neuronsHintDots(fresh, false, false)).toEqual({ trigger: false, row: false })
    expect(neuronsHintDots(fresh, true, false, false)).toEqual({ trigger: false, row: false })
    expect(neuronsHintDots(fresh, true, true)).toEqual({ trigger: true, row: false })
    expect(neuronsHintDots({ menuOpened: true, neuronsOnce: false }, true, true)).toEqual({ trigger: false, row: false })
    useSettingsStore.getState().updateSettings({ appMode: 'cloud' })
    render(<PluginsDropdown openUpward />)
    expect(screen.queryByTestId('plugins-hint')).toBeNull()
  })

  it('hangs on one constant marked for 3.1.1', () => {
    const src = readFileSync(join(__dirname, '../../../lib/neurons-hint.ts'), 'utf8')
    expect(src).toMatch(/remove in 3\.1\.1 \*\/\nexport const NEURONS_HINT_ON = true/)
  })
})
