/**
 * Der Rust-Proxy traegt nicht nur die Adressen auf diesem Rechner.
 *
 * `useLocalProxy` ist `isLanBackend || !isDirectFetchAllowed(host)`. Der zweite
 * Halbsatz ist der wichtige: die feste CSP kennt eine Handvoll Hosts, und JEDER
 * andere Host geht durch den Proxy, weil die Anfrage sonst schon im Webview
 * stirbt. Das ist genau der Fall, den ein Nutzer selbst anlegt, wenn er einen
 * eigenen OpenAI- oder Anthropic-kompatiblen Anbieter auf seiner eigenen Domain
 * eintraegt.
 *
 * Die Uebersetzung der Proxy-Absage fragte aber `isPrivateOrLanHost`, also eine
 * zweite, engere Frage als die, nach der der Transport gewaehlt wurde. Wer
 * seinen eigenen Server eintrug und das Netz verlor, las den Namen eines
 * Rust-Befehls im Chatfenster. Beim Anthropic-Anbieter fehlte die Uebersetzung
 * ganz, und `parseError` kannte die Form `{"error": "<Zeichenkette>"}` nicht
 * einmal, die der Proxy liefert.
 *
 * Lauf: npx vitest run src/api/__tests__/der-proxy-traegt-mehr-als-nur-127-0-0-1.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderConfig } from '../providers/types'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return {
    ...actual,
    isTauri: () => false,
    localFetch: vi.fn(),
    localFetchStream: vi.fn(),
  }
})

import { OpenAIProvider } from '../providers/openai-provider'
import { AnthropicProvider } from '../providers/anthropic-provider'
import { localFetchStream } from '../backend'

const stream = localFetchStream as ReturnType<typeof vi.fn>

/** Genau das, was der Proxy bei einer abgelehnten Verbindung zurueckgibt. */
const abgelehnt = (url: string) => () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        error: `proxy_localhost_stream_chunked: error sending request for url (${url})`,
      }),
      { status: 503 },
    ),
  )

const eigeneDomain: ProviderConfig = {
  id: 'openai', name: 'My Endpoint', enabled: true,
  baseUrl: 'https://llm.meine-firma.de/v1', apiKey: 'x', isLocal: false,
}

const claudeLokal: ProviderConfig = {
  id: 'anthropic', name: 'Claude Relay', enabled: true,
  baseUrl: 'http://127.0.0.1:8787', apiKey: 'x', isLocal: true,
}

const claudeEigeneDomain: ProviderConfig = {
  id: 'anthropic', name: 'Claude Relay', enabled: true,
  baseUrl: 'https://relay.meine-firma.de', apiKey: 'x', isLocal: false,
}

const claudeEcht: ProviderConfig = {
  id: 'anthropic', name: 'Anthropic', enabled: true,
  baseUrl: 'https://api.anthropic.com', apiKey: 'x', isLocal: false,
}

const fehlerVon = async (gen: AsyncGenerator<unknown>): Promise<Error> => {
  try {
    for await (const _ of gen) { /* bis zum Knall */ }
  } catch (e) {
    return e as Error
  }
  throw new Error('es kam gar kein Fehler')
}

beforeEach(() => { vi.clearAllMocks() })

describe('ein eigener Anbieter auf einer eigenen Domain', () => {
  it('bekommt einen Satz, keinen Rust-Befehlsnamen', async () => {
    stream.mockImplementation(abgelehnt('https://llm.meine-firma.de/v1/chat/completions'))
    const e = await fehlerVon(new OpenAIProvider(eigeneDomain).chatStream('irgendwas', []))
    expect(e.message).not.toContain('proxy_localhost_stream_chunked')
    expect(e.message).not.toContain('error sending request')
    expect(e.message).toContain('My Endpoint')
    expect(e.message).toContain('llm.meine-firma.de')
  })

  it('bekommt den Rat fuer die Ferne, nicht den fuer den eigenen Rechner', async () => {
    // "Start it and send again" waere Unsinn: der Server steht woanders und
    // gehoert dem Nutzer vielleicht nicht einmal.
    stream.mockImplementation(abgelehnt('https://llm.meine-firma.de/v1/chat/completions'))
    const e = await fehlerVon(new OpenAIProvider(eigeneDomain).chatStream('irgendwas', []))
    expect(e.message).not.toContain('still starting up')
    expect(e.message).toMatch(/address may be wrong|check your network/i)
  })
})

describe('der Anthropic-Anbieter spricht dieselbe Sprache', () => {
  it('nennt einen toten Server auf 127.0.0.1 beim Namen', async () => {
    stream.mockImplementation(abgelehnt('http://127.0.0.1:8787/v1/messages'))
    const e = await fehlerVon(new AnthropicProvider(claudeLokal).chatStream('claude-opus-4-20250514', []))
    expect(e.message).not.toContain('proxy_localhost_stream_chunked')
    expect(e.message).toContain('Claude Relay')
    expect(e.message).toContain('127.0.0.1:8787')
    expect(e.message).toContain('Settings, AI Backends')
    // Der alte Text: die Zeile, die keine Frage beantwortet.
    expect(e.message).not.toBe('Anthropic: Request failed')
  })

  it('gilt genauso fuer ein Relay auf einer eigenen Domain', async () => {
    stream.mockImplementation(abgelehnt('https://relay.meine-firma.de/v1/messages'))
    const e = await fehlerVon(new AnthropicProvider(claudeEigeneDomain).chatStream('claude-opus-4-20250514', []))
    expect(e.message).not.toContain('proxy_localhost_stream_chunked')
    expect(e.message).toContain('relay.meine-firma.de')
    expect(e.message).not.toContain('still starting up')
  })

  it('liest die flache Fehlerform des Proxys ueberhaupt erst', async () => {
    // Kein Transportfehler, sondern die Antwort eines Relays, das der Proxy
    // durchgereicht hat. Frueher blieb davon nichts uebrig, weil parseError
    // nur `data.error.message` kannte.
    stream.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'upstream key rejected' }), { status: 400 })),
    )
    const e = await fehlerVon(new AnthropicProvider(claudeLokal).chatStream('claude-opus-4-20250514', []))
    expect(e.message).toBe('upstream key rejected')
  })

  it('laesst die verschachtelte Form der echten API in Ruhe', async () => {
    stream.mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens too large' } }),
        { status: 400 },
      )),
    )
    const e = await fehlerVon(new AnthropicProvider(claudeLokal).chatStream('claude-opus-4-20250514', []))
    expect(e.message).toBe('max_tokens too large')
  })
})

describe('was NICHT uebersetzt werden darf', () => {
  it('api.anthropic.com faehrt direkt und bekommt keinen Satz ueber Server starten', async () => {
    // Der Host steht in der CSP, also nimmt er nie den Proxy. Waere die Sperre
    // hier weg, bekaeme die echte Cloud einen Ratschlag zum Neustarten.
    const direkt = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'overloaded_error' } }), { status: 529 })),
    )
    vi.stubGlobal('fetch', direkt)
    try {
      const e = await fehlerVon(new AnthropicProvider(claudeEcht).chatStream('claude-opus-4-20250514', []))
      expect(direkt).toHaveBeenCalled()
      expect(stream).not.toHaveBeenCalled()
      expect(e.message).not.toContain('is not answering')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('die eigenen Worte eines erreichbaren Servers ueberleben', async () => {
    stream.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'context length exceeded' } }), { status: 400 })),
    )
    const e = await fehlerVon(new OpenAIProvider(eigeneDomain).chatStream('irgendwas', []))
    expect(e.message).toContain('context length exceeded')
    expect(e.message).not.toContain('is not answering')
  })
})
