/**
 * @vitest-environment jsdom
 *
 * Der farbige Punkt in der ZUGEKLAPPTEN Anbieterzeile muss sagen, was seine
 * Farbe bedeutet.
 *
 * Befund vom 04.09.2026, Settings, AI Backends, ohne eine Zeile aufzuklappen:
 * der Punkt trug weder `title` noch `aria-label`, und die Wifi-Zeichen daneben
 * auch nicht. Zu sehen war ein Farbfleck, und niemand sagte, wofuer die Farbe
 * steht; fuer einen Screenreader gab es ihn ueberhaupt nicht. Die Erklaerung
 * stand nur im Statusfeld im aufgeklappten Koerper, also genau dort, wo man
 * erst hinkommt, wenn man den Punkt schon verstanden hat.
 *
 * Geprueft wird an der gerenderten Zeile und nicht am Quelltext, weil die
 * Frage lautet, was im Bedienungsbaum ankommt. Zwei Dinge zaehlen dabei:
 *
 *   1. Der Punkt traegt das Wort seines Zustands.
 *   2. Es ist DASSELBE Wort, das der aufgeklappte Koerper benutzt. Ein zweites
 *      Wort fuer denselben Zustand waere nur der naechste Befund, deshalb
 *      vergleicht der Test die beiden Stellen miteinander statt jede fuer sich
 *      gegen eine Zeichenkette im Test.
 *
 * Lauf: npx vitest run src/components/settings/__tests__/der-zustandspunkt-sagt-seine-farbe.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ProviderConfig, ProviderId } from '../../../api/providers/types'

const checkConnection = vi.fn()
const listModels = vi.fn()

vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({})),
  // Ohne Tauri fragt die laufende Engine-Schleife nichts, also entscheidet
  // hier allein die Sonde, und der Test kann jeden Zustand herstellen.
  isTauri: () => false,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../../api/builtin-ensure', () => ({
  readBuiltinSlotStatus: vi.fn(async () => null),
  diagnoseBuiltinEngine: vi.fn(async () => ({ ok: false, reason: '' })),
}))
vi.mock('../../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../../api/providers')>('../../../api/providers')
  return { ...actual, getProvider: () => ({ checkConnection, listModels }) }
})

const { ProviderSettings } = await import('../ProviderConfig')
const { useProviderStore } = await import('../../../stores/providerStore')

const aus = (id: ProviderId, name: string, baseUrl: string): ProviderConfig =>
  ({ id, name, enabled: false, baseUrl, apiKey: '', isLocal: false })

beforeEach(() => {
  checkConnection.mockReset()
  listModels.mockReset()
  // Genau eine Zeile auf dem Schirm, damit jede Abfrage unten eindeutig ist.
  useProviderStore.setState({
    providers: {
      ollama: { id: 'ollama', name: 'Ollama', enabled: true, baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true },
      openai: aus('openai', 'LU Engine', 'http://127.0.0.1:8127/v1'),
      anthropic: aus('anthropic', 'Anthropic', 'https://api.anthropic.com'),
      'lu-cloud': aus('lu-cloud', 'LU Cloud', 'https://lu-labs.ai/api/inference/v1'),
    },
  })
})
afterEach(cleanup)

/** Die Liste aufbauen und die Sonde zu Ende laufen lassen. */
async function liste(erreichbar: boolean | Promise<boolean>, modelle: unknown[] | null = ['ein-modell']) {
  checkConnection.mockReturnValue(Promise.resolve(erreichbar))
  listModels.mockResolvedValue(modelle)
  const { container } = render(createElement(ProviderSettings))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return container
}

const punkt = () => screen.getByTestId('provider-dot')

describe('der Punkt in der zugeklappten Zeile', () => {
  it('sagt "Connected", wenn der Anbieter Modelle anbietet', async () => {
    await liste(true, ['ein-modell'])
    expect(punkt().getAttribute('aria-label')).toBe('Connected')
    expect(punkt().getAttribute('title')).toBe('Connected')
  })

  it('sagt "Failed", wenn die Sonde durchgefallen ist', async () => {
    await liste(false)
    expect(punkt().getAttribute('aria-label')).toBe('Failed')
    expect(punkt().getAttribute('title')).toBe('Failed')
  })

  it('sagt "Reachable, no models", wenn der Server ohne Modell antwortet', async () => {
    await liste(true, [])
    expect(punkt().getAttribute('aria-label')).toBe('Reachable, no models')
    expect(punkt().getAttribute('title')).toBe('Reachable, no models')
  })

  it('taucht im Bedienungsbaum als Bild mit Namen auf, nicht als Farbfleck', async () => {
    await liste(true, ['ein-modell'])
    expect(punkt().getAttribute('role')).toBe('img')
    // Und damit traegt die Kopfzeile ihren Zustand auch dann, wenn sie nur
    // ueber den Bedienungsbaum gelesen wird.
    expect(screen.getByRole('button', { name: /Connected/ })).toBeTruthy()
  })

  it('behauptet nichts, solange noch niemand gemessen hat', async () => {
    // Eine Sonde, die nie antwortet: der Zustand bleibt 'idle', und dazu
    // schweigt auch das Statusfeld im Koerper. Eine Farbe ohne Aussage ist
    // besser als ein Wort, das keiner geprueft hat.
    await liste(new Promise<boolean>(() => {}))
    expect(punkt().hasAttribute('aria-label')).toBe(false)
    expect(punkt().hasAttribute('title')).toBe(false)
    expect(punkt().hasAttribute('role')).toBe(false)
  })
})

describe('dasselbe Wort wie im aufgeklappten Koerper', () => {
  const faelle: Array<[string, boolean, unknown[] | null]> = [
    ['Connected', true, ['ein-modell']],
    ['Failed', false, null],
    ['Reachable, no models', true, []],
  ]

  it.each(faelle)('%s steht am Punkt und im Statusfeld, und ist ein Wort', async (_name, erreichbar, modelle) => {
    await liste(erreichbar, modelle)
    const wort = punkt().getAttribute('aria-label') ?? ''
    expect(wort).not.toBe('')
    // Aufklappen: das Statusfeld neben Test und Disable muss genau dieses Wort
    // fuehren. Waeren es zwei Quellen, liefen sie hier auseinander.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(wort) }))
    expect(screen.getByText(wort)).toBeTruthy()
  })
})

describe('das Wifi-Zeichen daneben', () => {
  // Der Befund nannte auch diese Zeichen. Gemessen stimmt das nur halb: lucide
  // setzt `aria-hidden` selbst, solange kein a11y-Merkmal am Symbol haengt, sie
  // waren also nie im Bedienungsbaum. Genau deshalb steht das Wort am Punkt und
  // nicht hier. Der Fall bleibt als Wache stehen: wer dem Symbol einen Namen
  // gibt, schaltet lucides `aria-hidden` ab, und der Zustand wird zweimal
  // vorgelesen.
  it('ist Zierde und spricht den Zustand nicht ein zweites Mal', async () => {
    const container = await liste(true, ['ein-modell'])
    const zeichen = container.querySelectorAll('.lucide-wifi, .lucide-wifi-off')
    expect(zeichen.length).toBe(1)
    expect(zeichen[0].getAttribute('aria-hidden')).toBe('true')
  })

  it('bleibt weg, solange der Zustand keinen Namen hat', async () => {
    const container = await liste(new Promise<boolean>(() => {}))
    expect(container.querySelectorAll('.lucide-wifi, .lucide-wifi-off').length).toBe(0)
  })
})
