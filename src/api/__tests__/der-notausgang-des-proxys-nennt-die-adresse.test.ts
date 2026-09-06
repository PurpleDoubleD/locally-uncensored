/**
 * `localFetchStream` gibt zwei Antwortkoerper aus, die es selbst schreibt.
 *
 * Nicht der Rust-Proxy, nicht der Server: diese zwei Zeilen sind unsere. Die
 * eine faellt im Web-Build an, wo es keinen Proxy zum Ausweichen gibt, die
 * andere in einem Tauri-Fenster, in dem die Channel-Schicht nicht laedt. Beide
 * hiessen frueher `Network error` und `Local backend unreachable (proxy and
 * direct fetch both failed)`, und keine von beiden nannte eine Adresse. Damit
 * fiel jede durch `isLocalTransportFailure`, und der Anbieter stellte sie roh
 * ins Fenster, statt sie in einen Satz zu uebersetzen.
 *
 * Diese Tests halten fest, dass unsere eigenen Notausgaenge in der Form
 * ankommen, die der Filter lesen kann.
 *
 * Lauf: npx vitest run src/api/__tests__/der-notausgang-des-proxys-nennt-die-adresse.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Die Channel-Schicht ist hier grundsaetzlich kaputt. Das ist der zweite Fall:
// ein Tauri-Fenster, in dem der dynamische Import stirbt.
vi.mock('@tauri-apps/api/core', () => {
  throw new Error('Channel layer unavailable in this window')
})

import { localFetchStream } from '../backend'
import { isLocalTransportFailure, localBackendUnreachableMessage } from '../../lib/local-backend-transport'
import { isRecord } from '../../types/json-guards'

const ZIEL = 'http://127.0.0.1:1234/v1/chat/completions'
const BASIS = 'http://127.0.0.1:1234/v1'

function tauriMode(on: boolean) {
  const existing: unknown = Reflect.get(globalThis, 'window')
  const w: Record<string, unknown> = isRecord(existing) ? existing : {}
  Reflect.set(globalThis, 'window', w)
  if (on) w.__TAURI_INTERNALS__ = {}
  else { delete w.__TAURI_INTERNALS__; delete w.__TAURI__ }
}

/** Der Fehlertext, den ein Anbieter aus so einer Antwort herausliest. */
async function fehlertext(res: Response): Promise<string> {
  const data: unknown = await res.json()
  const err = isRecord(data) ? data.error : undefined
  return typeof err === 'string' ? err : String(err)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
})

afterEach(() => {
  vi.unstubAllGlobals()
  tauriMode(false)
})

describe('ohne Proxy, also im Web-Build', () => {
  it('nennt die Adresse, an der es gescheitert ist', async () => {
    tauriMode(false)
    const res = await localFetchStream(ZIEL, { method: 'POST', body: '{}' })
    expect(res.status).toBe(500)
    expect(await fehlertext(res)).toContain('127.0.0.1:1234')
  })

  it('kommt beim Anbieter als Satz an und nicht als Rohzeile', async () => {
    tauriMode(false)
    const res = await localFetchStream(ZIEL, { method: 'POST', body: '{}' })
    const roh = await fehlertext(res)
    expect(isLocalTransportFailure(roh, BASIS)).toBe(true)
    const satz = localBackendUnreachableMessage('LM Studio', BASIS)
    expect(satz).toContain('LM Studio')
    expect(satz).not.toContain('failed to fetch')
  })
})

describe('mit Proxy, dessen Channel-Schicht nicht laedt', () => {
  it('nennt die Adresse auch hier', async () => {
    tauriMode(true)
    const res = await localFetchStream(ZIEL, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect(await fehlertext(res)).toContain('127.0.0.1:1234')
  })

  it('wird ebenfalls uebersetzt statt durchgereicht', async () => {
    tauriMode(true)
    const res = await localFetchStream(ZIEL, { method: 'POST', body: '{}' })
    expect(isLocalTransportFailure(await fehlertext(res), BASIS)).toBe(true)
  })
})

describe('die Grenze, die dabei nicht verrutschen darf', () => {
  it('schiebt den Notausgang nicht einem anderen Server auf diesem Rechner zu', async () => {
    tauriMode(false)
    const res = await localFetchStream(ZIEL, { method: 'POST', body: '{}' })
    const roh = await fehlertext(res)
    // Ollama laeuft daneben auf 11434 und ist voellig gesund.
    expect(isLocalTransportFailure(roh, 'http://127.0.0.1:11434')).toBe(false)
  })

  it('ein blankes "Failed to fetch" ohne Adresse bleibt unuebersetzt', () => {
    // Der Kommentar in local-backend-transport.ts sagt genau das: der Port ist
    // freiwillig, der Hostname nicht. Ein Server darf dieselben Worte ueber
    // eine Datei sagen, die er nicht lesen konnte, und dann waere unsere
    // Uebersetzung eine Luege ueber eine Maschine, die laeuft.
    expect(isLocalTransportFailure('TypeError: Failed to fetch', BASIS)).toBe(false)
    expect(isLocalTransportFailure('ECONNREFUSED 127.0.0.1', BASIS)).toBe(true)
  })
})
