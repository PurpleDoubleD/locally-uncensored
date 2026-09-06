/**
 * `pullModel` warf `new Error("Failed to pull model")` und liess den Koerper
 * der Antwort ungelesen liegen.
 *
 * Genau darin stand aber der Grund. Wer Ollama beendet und dann in Models einen
 * Download startet, bekommt vom Proxy
 *   Response(503, {"error": "proxy_localhost_stream_chunked: error sending
 *   request for url (http://127.0.0.1:11434/api/pull)"})
 * zurueck, und die Karte im Download-Bereich sagte dazu vier Worte, die nichts
 * erklaeren. Jetzt wird der Koerper gelesen, und die Rohzeile wird in denselben
 * Satz uebersetzt, den Chat und Agentenlauf schon benutzen.
 *
 * Lauf: npx vitest run src/api/__tests__/der-abgebrochene-pull-sagt-warum.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return {
    ...actual,
    isTauri: () => true,
    localFetch: vi.fn(),
    localFetchStream: vi.fn(),
    ollamaUrl: (path: string) => `http://127.0.0.1:11434/api${path}`,
  }
})

import { pullModel } from '../ollama'
import { localFetchStream } from '../backend'

const stream = localFetchStream as ReturnType<typeof vi.fn>

const fehlerVon = async (p: Promise<unknown>): Promise<Error> =>
  p.then(() => { throw new Error('es kam gar kein Fehler') }, (e: unknown) => e as Error)

beforeEach(() => { vi.clearAllMocks() })

describe('Ollama laeuft nicht, und der Nutzer klickt Download', () => {
  it('liest den Grund aus dem Koerper und macht einen Satz daraus', async () => {
    stream.mockResolvedValue(new Response(
      JSON.stringify({
        error: 'proxy_localhost_stream_chunked: error sending request for url (http://127.0.0.1:11434/api/pull)',
      }),
      { status: 503 },
    ))
    const e = await fehlerVon(pullModel('llama3'))
    expect(e.message).not.toContain('proxy_localhost_stream_chunked')
    expect(e.message).not.toBe('Failed to pull model')
    expect(e.message).toContain('Ollama')
    expect(e.message).toContain('127.0.0.1:11434')
    expect(e.message).toContain('Settings, AI Backends')
  })
})

describe('Ollama laeuft und sagt selbst Nein', () => {
  it('behaelt die Worte des Servers, statt sie zu ersetzen', async () => {
    stream.mockResolvedValue(new Response(
      JSON.stringify({ error: 'pull model manifest: file does not exist' }),
      { status: 500 },
    ))
    const e = await fehlerVon(pullModel('gibtsnicht'))
    expect(e.message).toContain('file does not exist')
    expect(e.message).toContain('500')
    expect(e.message).not.toContain('is not answering')
  })

  it('sagt wenigstens den Status, wenn der Koerper leer ist', async () => {
    stream.mockResolvedValue(new Response('', { status: 404 }))
    const e = await fehlerVon(pullModel('gibtsnicht'))
    expect(e.message).toBe('Failed to pull model: HTTP 404')
  })
})

describe('der gute Fall bleibt der gute Fall', () => {
  it('reicht eine laufende Antwort ungelesen durch', async () => {
    const ok = new Response('{"status":"pulling"}\n', { status: 200 })
    stream.mockResolvedValue(ok)
    const res = await pullModel('llama3')
    expect(res).toBe(ok)
    expect(res.bodyUsed).toBe(false)
  })
})
