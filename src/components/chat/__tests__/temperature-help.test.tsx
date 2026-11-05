// @vitest-environment jsdom
/**
 * The "?" next to every temperature control says what the slider does.
 *
 * David, 27.10.2026: "wir müssen klar anzeigen was temperatur macht in desktop
 * und web, sonst beschweren sich immer leute." The A33 warning only speaks
 * from 1.2 up; this explains the slider before anyone gets there. Hover shows
 * the text, a tap shows it as a line (touch screens have no hover). Chat
 * popup, Settings page and persona editor. The sentence is the web app's
 * word for word.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useChatStore } from '../../../stores/chatStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { DEFAULT_SETTINGS } from '../../../lib/constants'
import { TEMPERATURE_HELP, TEMPERATURE_HELP_LABEL, TEMPERATURE_WARN, TEMPERATURE_MAX } from '../../../lib/sampling'
import { SamplingControls } from '../SamplingControls'
import { SliderControl } from '../../settings/SliderControl'
import { SystemPromptEditor } from '../../personas/SystemPromptEditor'

beforeEach(() => {
  useChatStore.setState({
    conversations: [{ id: 'c1', title: 'c1', messages: [], model: 'm', systemPrompt: '', createdAt: 0, updatedAt: 0 }] as never,
    activeConversationId: 'c1',
  })
  useSettingsStore.getState().updateSettings({ temperature: DEFAULT_SETTINGS.temperature, personasEnabled: false })
  useAgentModeStore.setState({ agentModeActive: {} })
})
afterEach(() => cleanup())

describe('what temperature does, next to the slider', () => {
  it('the same sentence as the web app, true to the limits and the default', () => {
    expect(TEMPERATURE_HELP).toBe(
      'Temperature controls how random the answers are. Low (0.2 to 0.5): focused and repeatable. '
      + 'Around 0.7: balanced, the default. Above 1.2: answers can turn into random text.',
    )
    expect(DEFAULT_SETTINGS.temperature).toBe(0.7)
    expect(TEMPERATURE_WARN).toBe(1.2)
    expect(TEMPERATURE_MAX).toBeGreaterThan(TEMPERATURE_WARN)
    expect(TEMPERATURE_HELP).not.toMatch(/[–—]/)
  })

  it('chat popup: hover text on the "?", a tap shows it and leaves the value alone', () => {
    render(<SamplingControls />)
    fireEvent.click(screen.getByTestId('sampling-trigger'))
    const mark = screen.getByRole('button', { name: TEMPERATURE_HELP_LABEL })
    expect(mark.getAttribute('title')).toBe(TEMPERATURE_HELP)
    expect(screen.queryByTestId('temperature-help-text')).toBeNull()
    fireEvent.click(mark)
    expect(screen.getByTestId('temperature-help-text').textContent).toBe(TEMPERATURE_HELP)
    expect(useSettingsStore.getState().settings.temperature).toBe(DEFAULT_SETTINGS.temperature)
    expect(screen.getAllByRole('button', { name: TEMPERATURE_HELP_LABEL })).toHaveLength(1)
  })

  it('Settings page slider shows it, and the page passes it in', () => {
    render(<SliderControl label="Temperature" help={{ text: TEMPERATURE_HELP, label: TEMPERATURE_HELP_LABEL }} value={0.7} min={0} max={1.5} step={0.1} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: TEMPERATURE_HELP_LABEL }))
    expect(screen.getByText(TEMPERATURE_HELP)).toBeTruthy()
    const page = readFileSync(resolve(__dirname, '../../settings/SettingsPage.tsx'), 'utf8')
    expect(page).toMatch(/<SliderControl label="Temperature" help=\{\{ text: TEMPERATURE_HELP, label: TEMPERATURE_HELP_LABEL \}\}/)
  })

  it('persona editor: the same "?" on its temperature field', () => {
    render(<SystemPromptEditor />)
    const mark = screen.getByRole('button', { name: TEMPERATURE_HELP_LABEL })
    expect(mark.getAttribute('title')).toBe(TEMPERATURE_HELP)
    fireEvent.click(mark)
    expect(screen.getByTestId('temperature-help-text').textContent).toBe(TEMPERATURE_HELP)
  })
})
