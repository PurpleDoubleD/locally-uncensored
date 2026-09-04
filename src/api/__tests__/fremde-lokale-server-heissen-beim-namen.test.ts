/**
 * Der Nachlauf zum P1-Fehlfund: nachdem die Schlussmarke im Proxy nicht mehr
 * jede Fehlermeldung verschluckt (proxy.rs), kommt die rohe Zeile
 *
 *   proxy_localhost_stream_chunked: error sending request for url
 *   (http://127.0.0.1:1234/v1/chat/completions)
 *
 * wirklich bei den Anbietern an. Beim eigenen Motor war die Uebersetzung schon
 * da. Bei LM Studio, llama.cpp, vLLM und Ollama war sie es nicht, und ohne sie
 * haette mein Fix einen Rust-Befehlsnamen ins Chatfenster gestellt. Genau das
 * pruefen diese Tests, einmal je Anbieter.
 *
 * Lauf: npx vitest run src/api/__tests__/fremde-lokale-server-heissen-beim-namen.test.ts
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
    ollamaUrl: (path: string) => `http://127.0.0.1:11434${path}`,
  }
})

import { OpenAIProvider } from '../providers/openai-provider'
import { OllamaProvider } from '../providers/ollama-provider'
import { localFetchStream } from '../backend'

const stream = localFetchStream as ReturnType<typeof vi.fn>

/** Genau das, was der Proxy bei einer abgelehnten Verbindung zurueckgibt. */
const abgelehnt = (url: string) =>
  new Response(
    JSON.stringify({ error: `proxy_localhost_stream_chunked: error sending request for url (${url})` }),
    { status: 503 },
  )

const lmStudio: ProviderConfig = {
  id: 'openai', name: 'LM Studio', enabled: true,
  baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'x', isLocal: true,
}

const echteCloud: ProviderConfig = {
  id: 'openai', name: 'OpenAI', enabled: true,
  baseUrl: 'https://api.openai.com/v1', apiKey: 'x', isLocal: false,
}

const ollama: ProviderConfig = {
  id: 'ollama', name: 'Ollama', enabled: true,
  baseUrl: 'http://127.0.0.1:11434', apiKey: '', isLocal: true,
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

describe('ein fremder lokaler Server, der nicht laeuft', () => {
  it('wird beim Namen genannt, nicht mit einem Rust-Befehl', async () => {
    stream.mockResolvedValue(abgelehnt('http://127.0.0.1:1234/v1/chat/completions'))
    const e = await fehlerVon(new OpenAIProvider(lmStudio).chatStream('irgendwas', []))
    expect(e.message).toContain('LM Studio')
    expect(e.message).toContain('127.0.0.1:1234')
    expect(e.message).toContain('Settings, AI Backends')
    expect(e.message).not.toContain('proxy_localhost_stream_chunked')
    expect(e.message).not.toMatch(/network/i)
  })

  it('gilt auch fuer Ollama, das denselben Proxy nimmt', async () => {
    stream.mockResolvedValue(abgelehnt('http://127.0.0.1:11434/api/chat'))
    const e = await fehlerVon(new OllamaProvider(ollama).chatStream('llama3', []))
    expect(e.message).toContain('Ollama')
    expect(e.message).toContain('127.0.0.1:11434')
    expect(e.message).not.toContain('proxy_localhost_stream_chunked')
  })
})

describe('was NICHT uebersetzt werden darf', () => {
  it('ein echter Serverfehler behaelt die Worte des Servers', async () => {
    stream.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'context length exceeded' } }), { status: 400 },
    ))
    const e = await fehlerVon(new OpenAIProvider(lmStudio).chatStream('irgendwas', []))
    expect(e.message).toContain('context length exceeded')
    expect(e.message).not.toContain('is not answering')
  })

  it('ein Cloud-Anbieter bekommt keinen Satz ueber das Starten von Servern', async () => {
    stream.mockResolvedValue(abgelehnt('https://api.openai.com/v1/chat/completions'))
    const e = await fehlerVon(new OpenAIProvider(echteCloud).chatStream('gpt-4o', []))
    expect(e.message).not.toContain('is not answering')
    expect(e.message).not.toContain('Start it and send again')
  })
})
