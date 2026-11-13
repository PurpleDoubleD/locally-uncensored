// @vitest-environment jsdom
/**
 * "Improve my prompt" (02.10.2026, Paritaet zu the web app):
 * der Schalter
 * in den erweiterten Einstellungen, nie im oder ueber dem Prompt-Fenster, und die
 * Details am Ergebnis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../../../../api/comfyui', () => ({
  classifyModel: () => 'sdxl',
  isI2VModel: () => false,
  isT2VCapable: () => true,
}))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
  }),
}))
vi.mock('../../../../api/providers', () => ({
  getProviderIdFromModel: (m: string) => (m.startsWith('lu-cloud::') ? 'lu-cloud' : 'ollama'),
  getProviderForModel: vi.fn(),
}))

import { AdvancedDrawer } from '../AdvancedDrawer'
import { ImproveToggle } from '../ImproveToggle'
import { PromptDetails } from '../PromptDetails'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { useModelStore } from '../../../../stores/modelStore'

beforeEach(() => {
  useCreateStore.setState({ backend: 'cloud', isGenerating: false, improvePrompt: false, cloudStudioOptions: {} })
  useModelStore.setState({ activeModel: 'lu-cloud::chat-model' })
})
afterEach(() => { cleanup() })

describe('Schalter Improve my prompt (Desktop)', () => {
  it('steht bei Bild, Video, Musik und Bearbeiten (B48)', () => {
    for (const [intent, shown] of [['image', true], ['video', true], ['music', true], ['edit', true], ['upscale', false]] as const) {
      useCreateStore.getState().setIntent(intent)
      const { unmount } = render(<ImproveToggle />)
      expect(!!screen.queryByRole('switch', { name: /improve my prompt/i })).toBe(shown)
      unmount()
    }
  })

  it('ist standardmaessig aus und schaltet sich um', () => {
    useCreateStore.getState().setIntent('image')
    render(<ImproveToggle />)
    const sw = screen.getByRole('switch', { name: /improve my prompt/i })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(useCreateStore.getState().improvePrompt).toBe(true)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('ohne Chatmodell ist er gesperrt und der Tooltip nennt den Grund', async () => {
    useModelStore.setState({ activeModel: null })
    useCreateStore.setState({ improvePrompt: true })
    useCreateStore.getState().setIntent('image')
    render(<ImproveToggle />)
    const sw = screen.getByRole('switch', { name: /improve my prompt/i }) as HTMLButtonElement
    expect(sw.disabled).toBe(true)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.mouseEnter(sw.parentElement as HTMLElement)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/pick a chat model/i))
  })

  it('der Tooltip nennt den Ort: eigener Rechner lokal, Chat-Buchung in der Cloud', async () => {
    useCreateStore.getState().setIntent('image')
    useModelStore.setState({ activeModel: 'qwen3:8b' })
    const { unmount } = render(<ImproveToggle />)
    fireEvent.mouseEnter(screen.getByRole('switch').parentElement as HTMLElement)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/your machine/i))
    unmount()
    useModelStore.setState({ activeModel: 'lu-cloud::chat-model' })
    render(<ImproveToggle />)
    fireEvent.mouseEnter(screen.getByRole('switch').parentElement as HTMLElement)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/billed like a short chat message/i))
  })
})

describe('Ort des Schalters (Desktop)', () => {
  it('steht in der Schublade der erweiterten Einstellungen, ueber den Reglern', () => {
    useCreateStore.getState().setIntent('image')
    render(<AdvancedDrawer open onClose={() => {}} />)
    expect(screen.getByText('Improve my prompt')).toBeTruthy()
    expect(screen.getByText('Quality')).toBeTruthy()
  })

  it('geschlossen steht er nirgends, also auch nicht beim Prompt-Feld', () => {
    useCreateStore.getState().setIntent('image')
    render(<AdvancedDrawer open={false} onClose={() => {}} />)
    expect(screen.queryByText('Improve my prompt')).toBeNull()
  })

  it('bei einem Studio-Modell steht er ebenfalls in der Schublade', () => {
    useCreateStore.getState().setIntent('video')
    render(<AdvancedDrawer open onClose={() => {}} studioModel="preset-wan-2.2-spicy-extend" />)
    expect(screen.getByText('Improve my prompt')).toBeTruthy()
  })
})

const ITEM = (extra: Partial<GalleryItem>): GalleryItem => ({
  id: 'a', type: 'image', filename: '', subfolder: '', prompt: 'A rewritten prompt.', negativePrompt: '',
  model: 'flux-schnell', modelType: 'unknown', seed: 1, steps: 0, cfgScale: 0, sampler: '', scheduler: '',
  width: 1, height: 1, batchSize: 1, createdAt: 1, ...extra,
})

describe('Details am Ergebnis (Desktop)', () => {
  it('zeigt Original und Fassung, die lief', () => {
    render(<PromptDetails item={ITEM({ promptOriginal: 'my own words' })} />)
    expect(screen.getByText('You wrote').parentElement?.nextElementSibling?.textContent).toBe('my own words')
    expect(screen.getByText('Sent to the model').parentElement?.nextElementSibling?.textContent).toBe('A rewritten prompt.')
  })

  // Box-Probe 03.10.2026: die Details sagten nicht, wer umgeschrieben hat.
  it('nennt, wer umgeschrieben hat', () => {
    render(<PromptDetails item={ITEM({ promptOriginal: 'my own words', rewrittenBy: 'Qwen enhancer, No Filter' })} />)
    expect(screen.getByText('Rewritten by').nextElementSibling?.textContent).toBe('Qwen enhancer, No Filter')
  })

  it('ein alter Eintrag ohne den Namen zeigt die Zeile nicht', () => {
    render(<PromptDetails item={ITEM({ promptOriginal: 'my own words' })} />)
    expect(screen.queryByText('Rewritten by')).toBeNull()
  })

  it('vermerkt ein gescheitertes Umschreiben ohne Fehlerton', () => {
    render(<PromptDetails item={ITEM({ improveFailed: true, prompt: 'my own words' })} />)
    expect(screen.getByText(/rewrite did not work/i)).toBeTruthy()
    expect(screen.queryByText('You wrote')).toBeNull()
    expect(screen.getByTestId('prompt-text').textContent).toBe('my own words')
  })
})

// 10.10.2026: bei jedem Bild, das die App gemacht hat, muss der Prompt
// zu sehen sein, mit einem Knopf zum Kopieren.
describe('Der Prompt am Ergebnis (Desktop)', () => {
  const clipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return writeText
  }

  it('ein Lauf ohne Umschreiben zeigt seinen Prompt, ohne die Zeilen des Umschreibens', () => {
    render(<PromptDetails item={ITEM({ prompt: 'a red apple on a plate' })} />)
    // D9 (3.0.7): the entry carries its model, seed and size, so the fold
    // names the settings too (die-galerie-zeigt-die-einstellungen.test.tsx).
    expect(screen.getByText('Prompt and settings')).toBeTruthy()
    expect(screen.getByTestId('prompt-text').textContent).toBe('a red apple on a plate')
    expect(screen.queryByText('You wrote')).toBeNull()
    expect(screen.queryByText('Sent to the model')).toBeNull()
  })

  it('unter der Buehne zugeklappt, in der Grossansicht aufgeklappt', () => {
    const { unmount } = render(<PromptDetails item={ITEM({})} />)
    expect((screen.getByTestId('prompt-details') as HTMLDetailsElement).open).toBe(false)
    unmount()
    render(<PromptDetails item={ITEM({})} open />)
    expect((screen.getByTestId('prompt-details') as HTMLDetailsElement).open).toBe(true)
  })

  it('der Knopf legt genau den Text, der lief, in die Zwischenablage', async () => {
    const writeText = clipboard()
    render(<PromptDetails item={ITEM({ prompt: '  a red apple\non a plate ' })} open />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
    expect(writeText).toHaveBeenCalledWith('a red apple\non a plate')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy prompt' }).textContent).toBe('Copied'))
  })

  it('nach einem Umschreiben hat jede der beiden Fassungen ihren Knopf', () => {
    const writeText = clipboard()
    render(<PromptDetails item={ITEM({ promptOriginal: 'my own words' })} open />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy what you wrote' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy what was sent to the model' }))
    expect(writeText.mock.calls).toEqual([['my own words'], ['A rewritten prompt.']])
  })

  it('eine verweigerte Zwischenablage meldet nichts und behauptet nichts', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true })
    render(<PromptDetails item={ITEM({})} open />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByRole('button', { name: 'Copy prompt' }).textContent).toBe('Copy')
  })

  it('ein Eintrag ohne Prompt zeigt nichts, auch keinen erfundenen Text', () => {
    for (const item of [
      ITEM({ prompt: '' }),
      ITEM({ prompt: '   ' }),
      // Bis 3.0.6 schrieb der Cloud-Start den Namen des Laufs in das Feld.
      ITEM({ prompt: 'Background removed', label: 'Background removed', intent: 'removebg' }),
      ITEM({ prompt: 'Background removed', intent: 'removebg' }),
      ITEM({ prompt: 'Talking character', label: 'Talking character', type: 'video' }),
    ]) {
      const { container, unmount } = render(<PromptDetails item={item} />)
      expect(container.firstChild).toBeNull()
      unmount()
    }
  })

  it('ein Ergebnis aus dem Chat bringt nur den Prompt seines Laufs mit', () => {
    render(<PromptDetails item={{ prompt: 'a red fox in the snow' }} open />)
    expect(screen.getByTestId('prompt-text').textContent).toBe('a red fox in the snow')
  })

  it('ein Klick in den Kasten schliesst die Grossansicht nicht', () => {
    clipboard()
    const onClose = vi.fn()
    render(<div onClick={onClose}><PromptDetails item={ITEM({})} open /></div>)
    fireEvent.click(screen.getByTestId('prompt-text'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
    expect(onClose).not.toHaveBeenCalled()
  })
})
