/**
 * @vitest-environment jsdom
 *
 * N2 (3.0.9), David 31.10.2026: Neurons "for people without experience".
 * One page in four numbered steps, the ways to make a slider as tabs, a
 * one-time introduction that Help brings back, and coordinates to paste and
 * to share. A pasted recipe sets the values and prepares what the model does
 * not have yet, one job after the other; Undo brings the old sliders back.
 *
 * Run: npx vitest run src/components/neuron/__tests__/neurons-for-beginners.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const apply = vi.fn(async (_path: string, _entries: unknown[], _tuning?: unknown) => ({ mix: null, restarted: true, load: 0 }))
const buildPreset = vi.fn(async (_path: string, _id: string) => ({ started: true }))
const buildOwn = vi.fn(async (..._a: unknown[]) => ({ started: true }))
const vectors: Array<Record<string, unknown>> = []
const job = vi.hoisted(() => ({ status: 'idle', error: null as string | null }))
const facts = vi.hoisted(() => ({ tweaked: [] as string[], original: null as string | null }))

vi.mock('../../../api/neuron', () => ({
  neuronPresets: async () => [
    { id: 'creative', left: 'Sober', right: 'Creative' },
    { id: 'detailed', left: 'Concise', right: 'Detailed' },
    { id: 'cheerful', left: 'Serious', right: 'Cheerful' },
  ],
  neuronInfo: async () => ({
    facts: { arch: 'qwen2', nLayer: 24, nEmbd: 896, template: 'chatMl', name: 'Qwen2.5 0.5B Instruct', tweaked: [...facts.tweaked], original: facts.original },
    modelKey: 'qwen-1', generator: true, band: [3, 20], vectors: [...vectors], sae: null, activeMix: null,
  }),
  neuronStatus: async () => ({ status: job.status, kind: '', title: 'Computing', modelPath: '/models/qwen.gguf', phaseLabel: '', step: 0, total: 0, bytesDone: 0, bytesTotal: 0, rateBps: 0, etaSecs: null, elapsedSecs: 0, resultId: null, error: job.error, logs: [] }),
  neuronApply: (p: string, e: unknown[], t?: unknown) => apply(p, e, t),
  neuronBuildPreset: (p: string, id: string) => buildPreset(p, id),
  neuronBuildOwn: (...a: unknown[]) => buildOwn(...a),
  neuronCancel: vi.fn(), neuronCompare: vi.fn(), neuronDelete: vi.fn(), neuronDismiss: vi.fn(),
  neuronFeatureAdd: vi.fn(), neuronSaeDownload: vi.fn(), neuronSaeSearch: vi.fn(),
}))
vi.mock('../../../api/engine', () => ({
  addGgufFile: vi.fn(),
  listBundledModels: async () => [{ name: 'qwen2.5-0.5b-instruct-q8_0', path: '/models/qwen.gguf', size: 1, loaded: true }],
  isEmbeddingGgufName: () => false,
  bundledEngineStatus: async () => ({ running: true, healthy: true, port: 8127, model_path: '/models/qwen.gguf', ctx: 8192 }),
}))
vi.mock('../../../api/backend', async (orig) => ({ ...(await orig<object>()), openExternal: vi.fn(), backendCall: vi.fn() }))
vi.mock('../../../api/builtin-ensure', () => ({ isManagedBuiltinSlot: () => true }))

import { NeuronView } from '../NeuronView'
import { useModelStore } from '../../../stores/modelStore'
import { useUIStore } from '../../../stores/uiStore'
import { useNeuronStore } from '../../../stores/neuronStore'
import { useNeuronIntroRequest } from '../../../stores/neuronIntroStore'
import { buildCommands } from '../../ui/command-actions'
import { SHORTCUT_ACTIONS, shortcutKeys } from '../../../hooks/useKeyboardShortcuts'

const CHEERFUL = { id: 'cheerful', kind: 'preset', name: 'Serious ↔ Cheerful', left: 'Serious', right: 'Cheerful', unit: 0.6, builtAt: 1, more: [], less: [] }

beforeEach(() => {
  apply.mockClear()
  buildPreset.mockClear()
  buildOwn.mockClear()
  vectors.length = 0
  job.status = 'idle'
  job.error = null
  facts.tweaked = []
  facts.original = null
  useNeuronStore.setState({ profiles: {}, scopeByModel: {}, introSeen: true })
  useNeuronIntroRequest.setState({ open: false })
  useModelStore.setState({ activeModel: 'openai::qwen2.5-0.5b-instruct-q8_0' })
})
afterEach(() => cleanup())

describe('Neurons for beginners: one page in steps', () => {
  it('reads top to bottom in four numbered steps', async () => {
    render(createElement(NeuronView))
    await screen.findByTestId('neuron-step-model')
    const titles = [...document.querySelectorAll('section h2')].map((h) => h.textContent)
    expect(titles).toEqual(['Pick a model', 'Choose your sliders', 'Try it: before and after', 'Keep and share'])
    // Each step has its number, and the model step is done once the model is read.
    await waitFor(() => expect(screen.getByTestId('neuron-step-model').querySelector('[data-step-done]')?.getAttribute('data-step-done')).toBe('true'))
    expect(screen.getByTestId('neuron-step-sliders').querySelector('[data-step-done]')?.getAttribute('data-step-done')).toBe('false')
  })

  it('shows the ways to make a slider as tabs, each with one line on what it is', async () => {
    render(createElement(NeuronView))
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Ready-made', 'From examples', 'Features', 'Coordinates'])
    fireEvent.click(screen.getByTestId('neuron-way-features'))
    expect(screen.getByTestId('neuron-features-none').textContent).toMatch(/Gemma 3 270M IT and Gemma 3 1B IT/)
    fireEvent.click(screen.getByTestId('neuron-way-own'))
    expect(screen.getByText(/Your own slider, from examples/)).toBeTruthy()
  })

  it('puts both ends and the value of a slider on one line, the slider under it', async () => {
    vectors.push(CHEERFUL)
    useNeuronStore.setState({ profiles: { 'qwen-1': { cheerful: 0.6 } } })
    render(createElement(NeuronView))
    const row = await screen.findByTestId('neuron-slider-cheerful')
    const line = row.firstElementChild as HTMLElement
    await waitFor(() => expect(row.querySelector('input[type=range]')).toBeTruthy())
    expect(line.className).toMatch(/grid-cols-\[1fr_auto_1fr\]/)
    expect(line.textContent).toBe('Serious+0.60Cheerful')
    expect(line.nextElementSibling?.tagName).toBe('INPUT')
    // And it is listed under "On right now".
    expect(within(screen.getByTestId('neuron-mix')).getByText('Cheerful')).toBeTruthy()
  })
})

// Mac check 31.10.: the slider ends read grey on dark. The house remaps
// `.dark .text-gray-700` to gray-500 (index.css, contrast layer), which beats
// a `dark:text-gray-200` next to it. The page uses the house's own greys.
it('uses the greys the house does not dim', () => {
  for (const f of ['NeuronView.tsx', 'parts.tsx', 'panels.tsx', 'NeuronIntro.tsx']) {
    const src = readFileSync(resolve(__dirname, '..', f), 'utf8')
    expect(src, f).not.toMatch(/text-gray-[67]00 dark:text-gray-/)
  }
})

describe('the introduction', () => {
  it('opens by itself the first time, once, and Help brings it back', async () => {
    useNeuronStore.setState({ introSeen: false })
    render(createElement(NeuronView))
    expect(await screen.findByTestId('neuron-intro')).toBeTruthy()
    expect(screen.getByTestId('neuron-intro-step').textContent).toBe('Step 1 of 5')
    fireEvent.click(screen.getByTestId('neuron-intro-next'))
    expect(screen.getByTestId('neuron-intro-step').textContent).toBe('Step 2 of 5')
    fireEvent.click(screen.getByTestId('neuron-intro-skip'))
    await waitFor(() => expect(screen.queryByTestId('neuron-intro')).toBeNull())
    expect(useNeuronStore.getState().introSeen).toBe(true)
    // Back from the page's own "How it works".
    fireEvent.click(screen.getAllByTestId('neuron-intro-open')[0])
    expect(await screen.findByTestId('neuron-intro')).toBeTruthy()
    expect(screen.getByTestId('neuron-intro-step').textContent).toBe('Step 1 of 5')
  })

  it('is in the command palette too', () => {
    const actions = buildCommands({ shortcuts: SHORTCUT_ACTIONS, keysFor: shortcutKeys, localViewsAvailable: true, setView: vi.fn(), openCompare: vi.fn(), toggleSidebar: vi.fn(), setActiveModel: vi.fn(), models: [], activeModel: null, quit: null })
    const intro = actions.find((a) => a.id === 'neuron-intro')
    expect(intro?.label).toBe('Neurons: how it works')
    intro!.run()
    expect(useNeuronIntroRequest.getState().open).toBe(true)
  })

  it('stands still with reduced motion', () => {
    const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8')
    const block = css.slice(css.indexOf('Neurons introduction (N2'))
    const reduced = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'))
    for (const cls of ['nintro-token', 'nintro-push', 'nintro-knob', 'nintro-line', 'nintro-type', 'nintro-tile']) {
      expect(block).toMatch(new RegExp(`\\.${cls}[^{]*\\{[^}]*animation:`))
      expect(reduced).toContain(`.neuron-intro .${cls}`)
    }
    expect(reduced).toMatch(/animation: none/)
    // What starts hidden and fades in must stand there, finished, when it
    // does not move (the code on card 5 was invisible otherwise).
    const shown = reduced.slice(reduced.lastIndexOf('.neuron-intro .nintro-type,'))
    const rule = shown.slice(0, shown.indexOf('}'))
    for (const cls of ['nintro-type', 'nintro-glow', 'nintro-arrive', 'nintro-tile', 'nintro-dash']) expect(rule).toContain(`.${cls}`)
    expect(rule).toMatch(/opacity: 1/)
  })
})

describe('coordinates', () => {
  it('reads a pasted recipe, prepares what is missing, and Undo brings the old sliders back', async () => {
    vectors.push(CHEERFUL)
    useNeuronStore.setState({ profiles: { 'qwen-1': { cheerful: 0.2 } } })
    render(createElement(NeuronView))
    await screen.findByTestId('neuron-slider-cheerful')
    fireEvent.click(screen.getByTestId('neuron-way-coords'))
    const input = await screen.findByTestId('neuron-coords-input')
    const link = 'locallyuncensored://neuron?v=1&model=Qwen2.5-0.5B-Instruct&c=%40cheerful%2B0.50+%40detailed-0.40&o=' +
      encodeURIComponent(JSON.stringify([{ n: 'Pirate', s: 0.5, m: ['Talk like a pirate.'], l: ['Talk plainly.'] }]))
    fireEvent.change(input, { target: { value: link } })
    const lines = screen.getAllByTestId('neuron-coords-line').map((l) => l.textContent)
    expect(lines[0]).toMatch(/@cheerful\+0\.50.*Ready$/)
    expect(lines[1]).toMatch(/@detailed-0\.40.*Will be prepared$/)
    expect(lines[2]).toMatch(/Pirate.*Will be prepared$/)
    expect(screen.getByTestId('neuron-coords-preview').textContent).toMatch(/That is the model you picked/)
    fireEvent.click(screen.getByTestId('neuron-coords-use'))
    const profile = useNeuronStore.getState().profiles['qwen-1']
    expect(profile.cheerful).toBe(0.5)
    expect(profile.detailed).toBe(-0.4)
    const ownId = Object.keys(profile).find((k) => k.startsWith('own-pirate-'))!
    expect(profile[ownId]).toBe(0.5)
    // The first job starts; the next waits until it has ended.
    await waitFor(() => expect(buildPreset).toHaveBeenCalledWith('/models/qwen.gguf', 'detailed'))
    expect(buildOwn).not.toHaveBeenCalled()
    await waitFor(() => expect(buildOwn).toHaveBeenCalledWith('/models/qwen.gguf', 'Pirate', ['Talk like a pirate.'], ['Talk plainly.'], ownId))
    fireEvent.click(screen.getByTestId('neuron-coords-undo'))
    expect(useNeuronStore.getState().profiles['qwen-1']).toEqual({ cheerful: 0.2 })
  })

  it('refuses a bad recipe in words and lets nothing through', async () => {
    render(createElement(NeuronView))
    fireEvent.click(await screen.findByTestId('neuron-way-coords'))
    fireEvent.change(await screen.findByTestId('neuron-coords-input'), { target: { value: 'locallyuncensored://neuron?v=1&c=L1N2%2B0.5&url=https://evil.example' } })
    expect(screen.getByTestId('neuron-coords-error').textContent).toMatch(/never has/)
    expect(screen.queryByTestId('neuron-coords-use')).toBeNull()
  })

  it('names what it cannot do yet: single neurons and other models', async () => {
    render(createElement(NeuronView))
    fireEvent.click(await screen.findByTestId('neuron-way-coords'))
    fireEvent.change(await screen.findByTestId('neuron-coords-input'), { target: { value: 'Qwen3.5-4B: L13N7956-1.0 L14N8949+1.0' } })
    expect(screen.getByTestId('neuron-coords-other-model').textContent).toMatch(/one exact model/)
    expect(screen.getAllByTestId('neuron-coords-line')[0].textContent).toMatch(/arrive with the next LU Engine update.*Next update$/)
    // Nothing the box could unlock, so no box.
    expect(screen.queryByTestId('neuron-coords-anyway')).toBeNull()
    // Zentrale 31.10.: never silent. Use says plainly why nothing changed.
    const before = JSON.stringify(useNeuronStore.getState().profiles)
    fireEvent.click(screen.getByTestId('neuron-coords-use'))
    expect(screen.getByTestId('neuron-coords-later').textContent).toBe('2 single neurons were not applied. Single neurons arrive with the next LU Engine update. LU already reads, checks and shares these lines.')
    expect(JSON.stringify(useNeuronStore.getState().profiles)).toBe(before)
  })

  it('applies the rest of a mixed recipe and names the neuron it left out', async () => {
    vectors.push(CHEERFUL)
    render(createElement(NeuronView))
    await screen.findByTestId('neuron-slider-cheerful')
    fireEvent.click(screen.getByTestId('neuron-way-coords'))
    fireEvent.change(await screen.findByTestId('neuron-coords-input'), { target: { value: '@cheerful+0.4 L14N8949+1.0' } })
    // FEHLER-N2 #1: one value, said as one.
    expect(screen.getByTestId('neuron-coords-use').textContent?.trim()).toBe('Use the one usable value')
    fireEvent.click(screen.getByTestId('neuron-coords-use'))
    expect(useNeuronStore.getState().profiles['qwen-1']).toEqual({ cheerful: 0.4 })
    expect(screen.getByTestId('neuron-coords-later').textContent).toMatch(/^One single neuron was not applied\./)
  })
})

describe('sharing', () => {
  it('shows the mix as coordinates and copies line and link', async () => {
    vectors.push(CHEERFUL)
    useNeuronStore.setState({ profiles: { 'qwen-1': { cheerful: 0.6 } } })
    const writeText = vi.fn(async (_t: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(createElement(NeuronView))
    const line = await screen.findByTestId('neuron-share-line')
    await waitFor(() => expect(line.textContent).toBe('Qwen2.5 0.5B Instruct · @cheerful+0.60'))
    fireEvent.click(screen.getByTestId('neuron-share-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toBe('LU neurons · Qwen2.5 0.5B Instruct · @cheerful+0.60\nlocallyuncensored://neuron?v=1&model=Qwen2.5+0.5B+Instruct&c=%40cheerful%2B0.60')
  })
})

// P11 FEHLER 10, David 31.10.2026: a model changed before computes worse or
// not at all. Say so before computing, and after a failure, with the way to
// its original.
describe('tweaked models', () => {
  it('says before computing that originals work best, and finds the original in Discover', async () => {
    facts.tweaked = ['fine-tune', 'merge', 'heretic', 'uncensored']
    facts.original = 'Qwen3.5 9B'
    useUIStore.setState({ currentView: 'neuron', discoverTarget: null, discoverQuery: null })
    render(createElement(NeuronView))
    const note = await screen.findByTestId('neuron-tweaked-note')
    expect(note.textContent).toMatch(/^Works best with original, untweaked models/)
    expect(note.textContent).toMatch(/fine-tune, merge, heretic, uncensored/)
    // Above the ways and their compute buttons, blocking nothing.
    expect(note.compareDocumentPosition(screen.getByTestId('neuron-way-ready')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((screen.getByTestId('neuron-compute-creative') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('neuron-get-original'))
    const ui = useUIStore.getState()
    expect([ui.currentView, ui.discoverTarget, ui.discoverQuery, ui.discoverOriginal]).toEqual(['models', 'builtin', 'Qwen3.5 9B', true])
    expect(useModelStore.getState().categoryFilter).toBe('text')
  })

  it('stays quiet on an original model', async () => {
    render(createElement(NeuronView))
    await screen.findByTestId('neuron-compute-creative')
    expect(screen.queryByTestId('neuron-tweaked-note')).toBeNull()
  })

  it('puts the way to the original next to a failure', async () => {
    facts.tweaked = ['heretic']
    facts.original = 'Qwen3.5 9B'
    job.status = 'failed'
    job.error = 'The vector tool cannot read this model. The Neuron tweaker works best with original, untweaked models: try the original of this model.'
    render(createElement(NeuronView))
    const ended = await screen.findByTestId('neuron-job-ended')
    expect(ended.textContent).toMatch(/try the original of this model/)
    expect((await within(ended).findByTestId('neuron-get-original-failed')).textContent).toBe('Get the original: Qwen3.5 9B')
  })
})
