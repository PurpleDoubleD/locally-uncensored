// @vitest-environment jsdom
/**
 * Accessibility names and states found missing in a DOM scan of the release
 * build (29.10.2026). Every control here already showed its meaning to a
 * sighted user (an icon, a caption, a colour); a screen reader got nothing.
 * The visible markup stays the same, only names and states are added.
 *
 * Run: npx vitest run src/components/__tests__/t1-a11y-names.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

vi.mock('../../hooks/useCloudAuth', () => ({
  useCloudAuth: () => ({ status: 'signed-out', login: vi.fn(), signup: vi.fn(), logout: vi.fn() }),
}))
vi.mock('../../api/cloud/supabase', () => ({ loginWithProvider: vi.fn() }))

const { ABCompare } = await import('../chat/ABCompare')
const { BenchmarkView } = await import('../models/BenchmarkView')
const { AccountPanel } = await import('../auth/AccountPanel')
const { PermissionSettings } = await import('../settings/PermissionSettings')
const { CodexModeDropdown } = await import('../chat/CodexModeDropdown')
const { ProviderSettings } = await import('../settings/ProviderConfig')
const { ChatInput } = await import('../chat/ChatInput')
const { useCompareStore } = await import('../../stores/compareStore')
const { usePermissionStore } = await import('../../stores/permissionStore')
const { useProviderStore } = await import('../../stores/providerStore')
const { useChatStore } = await import('../../stores/chatStore')

const here = dirname(fileURLToPath(import.meta.url))

afterEach(() => cleanup())

describe('1. Compare view', () => {
  it('names the back and send buttons, both model pickers and the prompt box', () => {
    useCompareStore.setState({ modelA: '', modelB: '', isStreamingA: false, isStreamingB: false, messagesA: [], messagesB: [] })
    render(<ABCompare />)
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    const send = screen.getByRole('button', { name: 'Send to both models' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(screen.getByRole('combobox', { name: 'Model A' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Model B' })).toBeTruthy()
    const prompt = screen.getByRole('textbox', { name: 'Prompt for both models' }) as HTMLInputElement
    expect(prompt.placeholder).toBe('Select both models first')
  })

  it('names the stop button while a side is streaming', () => {
    useCompareStore.setState({ modelA: 'a', modelB: 'b', isStreamingA: true, isStreamingB: false, messagesA: [], messagesB: [] })
    render(<ABCompare />)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
  })
})

describe('2. Benchmark view', () => {
  it('names the back arrow', () => {
    render(<BenchmarkView />)
    expect(screen.getByRole('button', { name: 'Back to models' })).toBeTruthy()
  })
})

describe('3. LU Cloud account', () => {
  it('names the Email and Password inputs, placeholders kept', () => {
    render(<AccountPanel />)
    expect((screen.getByLabelText('Email') as HTMLInputElement).placeholder).toBe('Email')
    expect((screen.getByLabelText('Password') as HTMLInputElement).placeholder).toBe('Password')
  })
})

describe('4. Agent permissions', () => {
  it('exposes the selected level per category with aria-pressed, in a group named by the category', () => {
    const perms = usePermissionStore.getState().globalPermissions
    render(<PermissionSettings />)
    const groups = screen.getAllByRole('group')
    expect(groups.length).toBeGreaterThanOrEqual(Object.keys(perms).length)
    for (const g of groups.slice(0, Object.keys(perms).length)) {
      expect(g.getAttribute('aria-label')).toBeTruthy()
      const buttons = Array.from(g.querySelectorAll('button'))
      expect(buttons.map((b) => b.textContent)).toEqual(['Blocked', 'Ask First', 'Auto'])
      expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
      expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'false')).toHaveLength(2)
    }
    const web = screen.getByRole('group', { name: 'Web Access' })
    const pressed = Array.from(web.querySelectorAll('button')).find((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed?.textContent).toBe({ blocked: 'Blocked', confirm: 'Ask First', auto: 'Auto' }[perms.web as string])
    fireEvent.click(screen.getAllByRole('button', { name: 'Blocked' })[0])
    expect(screen.getAllByRole('button', { name: 'Blocked' })[0].getAttribute('aria-pressed')).toBe('true')
    usePermissionStore.getState().resetToDefaults()
  })
})

describe('5. Code mode trigger', () => {
  it('says it opens a popup and whether it is open', () => {
    useChatStore.setState({ activeConversationId: null })
    render(<CodexModeDropdown />)
    const trigger = screen.getAllByRole('button')[0]
    expect(trigger.getAttribute('aria-haspopup')).toBe('true')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('6. Neurons view', () => {
  // NeuronView needs the bundled engine bridge to render its picker; its own
  // render test is the known flaky one, so this item is pinned on the source.
  it('ties the Model caption to the select', () => {
    const src = readFileSync(resolve(here, '../neuron/NeuronView.tsx'), 'utf8')
    expect(src).toMatch(/<label[^>]*htmlFor="neuron-model"[^>]*>Model<\/label>/)
    expect(src).toMatch(/<select\s+id="neuron-model"/)
  })
})

describe('7. AI Backends provider card', () => {
  it('ties the Endpoint caption to its input on an expanded card', () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const providers = useProviderStore.getState().providers
    const id = (Object.keys(providers) as (keyof typeof providers)[]).find((k) => k === 'ollama') ?? 'ollama'
    useProviderStore.setState({ providers: { ...providers, [id]: { ...providers[id], enabled: true } } })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByText('Ollama'))
    const endpoint = screen.getByLabelText('Endpoint') as HTMLInputElement
    expect(endpoint.placeholder).toBe('http://localhost:...')
    vi.unstubAllGlobals()
  })

  it('ties the API Key caption to its input on the cloud card', () => {
    const src = readFileSync(resolve(here, '../settings/ProviderConfig.tsx'), 'utf8')
    expect(src).toContain('htmlFor={`provider-url-${id}`}>Endpoint</label>')
    expect(src).toContain('htmlFor={`provider-key-${id}`}>API Key</label>')
    expect(src).toContain('id={`provider-key-${id}`}')
    expect(src.match(/aria-label=\{(isKeyVisible|keyVisible) \? 'Hide API key' : 'Show API key'\}/g)).toHaveLength(2)
  })
})

describe('8. Chat composer', () => {
  it('names the textarea "Message" and keeps its data attribute and placeholder', () => {
    useChatStore.setState({ activeConversationId: 'a' })
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} modelReady={() => true} />)
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(box.hasAttribute('data-lu-composer')).toBe(true)
    expect(box.placeholder).toBeTruthy()
  })
})
